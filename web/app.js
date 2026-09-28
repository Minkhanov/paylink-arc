"use strict";
/*
 * PayLink front-end — plain JavaScript, no build step.
 * Reads go through a public JSON-RPC endpoint (no wallet needed to view invoices or dashboards);
 * the only write is `pay()`, signed by the payer's browser wallet (EIP-1193).
 *
 * Arc specifics handled here:
 *  - native USDC (msg.value) has 18 decimals; the UI accepts at most 6 decimals so that the
 *    ERC-20 view (6 decimals) of the same balance always shows the exact amount;
 *  - finality is deterministic: one receipt = final, we poll the receipt every 250 ms and show
 *    the measured time to finality;
 *  - fees are paid in USDC, so the fee estimate is shown in dollars.
 */
(function () {
  const { ethers } = window;
  const CFG = window.PAYLINK_CONFIG;
  const ZERO = ethers.ZeroAddress;
  const NATIVE_DECIMALS = 18;
  const UI_DECIMALS = 6;
  const MAX_MEMO_BYTES = 140;
  const TYPICAL_PAY_GAS = 150000n; // pay() measured at ~149k gas on a local node (e2e test)

  const ABI = [
    "function pay(address merchant, uint256 amount, uint64 dueBy, bytes32 salt, string memo) payable returns (bytes32)",
    "function computeInvoiceId(address merchant, uint256 amount, uint64 dueBy, bytes32 salt, string memo) view returns (bytes32)",
    "function receiptOf(bytes32 invoiceId) view returns (tuple(address payer, uint64 paidAt, address merchant, uint64 blockNumber, uint256 amount))",
    "function isPaid(bytes32 invoiceId) view returns (bool)",
    "function paidInvoiceCount(address merchant) view returns (uint256)",
    "function paidInvoicesOf(address merchant, uint256 offset, uint256 limit) view returns (bytes32[])",
    "event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount, uint64 dueBy, bytes32 salt, string memo)",
    "error InvalidMerchant()",
    "error ZeroAmount()",
    "error WrongAmount(uint256 expected, uint256 sent)",
    "error InvoiceExpired(uint64 dueBy)",
    "error MemoTooLong(uint256 length)",
    "error AlreadyPaid(bytes32 invoiceId)",
    "error ForwardFailed()",
  ];
  const iface = new ethers.Interface(ABI);
  const TOPIC_PAID = iface.getEvent("InvoicePaid").topicHash;

  const state = {
    net: null, // { chainId, name, rpc, explorer, payLink }
    read: null, // JsonRpcProvider for reads
    contract: null, // read-only contract
    signer: null,
    account: null,
    invoice: null,
    watch: null, // token of the active polling loop
    dashRows: [],
  };

  // ------------------------------------------------------------------ helpers

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

  function parseHash() {
    const h = window.location.hash || "#/";
    const [path, query] = h.slice(1).split("?");
    return { path: path || "/", params: new URLSearchParams(query || "") };
  }

  function chainIdFromLocation() {
    const fromHash = Number(parseHash().params.get("c"));
    if (fromHash && CFG.networks[fromHash]) return fromHash;
    const fromQuery = Number(new URLSearchParams(window.location.search).get("chain"));
    if (fromQuery && CFG.networks[fromQuery]) return fromQuery;
    return CFG.defaultChainId;
  }

  /** 18-decimal native USDC -> "12.5" (at most 6 decimals, trailing zeros trimmed). */
  function fmtUsdc(wei) {
    const [i, f = ""] = ethers.formatUnits(wei, NATIVE_DECIMALS).split(".");
    const frac = f.slice(0, UI_DECIMALS).replace(/0+$/, "");
    return frac ? `${i}.${frac}` : i;
  }

  function parseAmount(text) {
    const t = String(text || "").trim().replace(",", ".");
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(t)) throw new Error("Enter an amount like 25 or 25.50 (at most 6 decimals).");
    const wei = ethers.parseUnits(t, NATIVE_DECIMALS);
    if (wei === 0n) throw new Error("The amount must be greater than zero.");
    return wei;
  }

  const memoBytes = (m) => new TextEncoder().encode(m).length;
  const fmtTime = (ts) => new Date(Number(ts) * 1000).toLocaleString();
  const explorerTx = (h) => (state.net.explorer ? `${state.net.explorer}/tx/${h}` : null);
  const explorerAddr = (a) => (state.net.explorer ? `${state.net.explorer}/address/${a}` : null);
  const setText = (id, text) => { $(id).textContent = text; };
  const hide = (id) => { $(id).hidden = true; };

  function linkOrText(el, href, text) {
    el.textContent = "";
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = text;
      el.appendChild(a);
    } else {
      el.textContent = text;
    }
  }

  function showStatus(id, kind, text) {
    const el = $(id);
    el.hidden = false;
    el.className = `status${kind ? ` ${kind}` : ""}`;
    el.textContent = text;
    return el;
  }

  function toast(text) {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;z-index:99;max-width:90vw";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  function friendlyError(e) {
    if (!e) return "Unknown error.";
    if (e.code === "ACTION_REJECTED" || e.code === 4001 || (e.info && e.info.error && e.info.error.code === 4001)) {
      return "Request rejected in the wallet.";
    }
    let rev = e.revert;
    if (!rev && typeof e.data === "string") {
      try { rev = iface.parseError(e.data); } catch (_) { rev = null; }
    }
    switch (rev && rev.name) {
      case "AlreadyPaid": return "This invoice has already been paid.";
      case "InvoiceExpired": return "This invoice has expired.";
      case "WrongAmount": return "Amount mismatch — the link may have been altered.";
      case "ForwardFailed": return "The recipient cannot receive USDC (transfer reverted). Nothing was charged.";
      case "InvalidMerchant": return "Invalid recipient address.";
      case "ZeroAmount": return "The amount must be greater than zero.";
      case "MemoTooLong": return "The memo is too long.";
      default: break;
    }
    const msg = e.shortMessage || e.reason || e.message || String(e);
    if (e.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(msg)) {
      return "Not enough USDC to cover the amount plus the network fee.";
    }
    return msg;
  }

  function computeInvoiceId(inv) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return ethers.keccak256(coder.encode(
      ["uint256", "address", "address", "uint256", "uint64", "bytes32", "bytes32"],
      [state.net.chainId, state.net.payLink, inv.merchant, inv.amountWei, inv.dueBy, inv.salt, ethers.keccak256(ethers.toUtf8Bytes(inv.memo))],
    ));
  }

  const isDeployed = () => Boolean(state.net.payLink) && state.net.payLink !== ZERO;

  /** Run `fn` every `ms` until it returns true or another loop replaces it. */
  function startPoll(fn, ms) {
    const token = {};
    state.watch = token;
    (async () => {
      while (state.watch === token) {
        try {
          if (await fn()) { if (state.watch === token) state.watch = null; return; }
        } catch (_) { /* transient RPC error: keep polling */ }
        await sleep(ms);
      }
    })();
  }
  const stopPoll = () => { state.watch = null; };

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // ------------------------------------------------------------------ network & wallet

  function initNetwork() {
    const chainId = chainIdFromLocation();
    if (state.net && state.net.chainId === chainId) return;
    const n = CFG.networks[chainId];
    state.net = { ...n, chainId };
    state.read = new ethers.JsonRpcProvider(n.rpc, chainId, { staticNetwork: ethers.Network.from(chainId), batchMaxCount: 1 });
    state.contract = new ethers.Contract(n.payLink, ABI, state.read);
    state.signer = null;

    const badge = $("net-badge");
    badge.textContent = n.name;
    badge.className = `badge${chainId === 5042 ? " live" : ""}`;
    const ft = $("ft-contract");
    if (isDeployed()) {
      ft.textContent = short(n.payLink);
      const href = explorerAddr(n.payLink);
      if (href) ft.href = href; else ft.removeAttribute("href");
    } else {
      ft.textContent = "not deployed on this network yet";
      ft.removeAttribute("href");
    }
    if (CFG.repoUrl) $("ft-source").href = CFG.repoUrl;
  }

  async function ensureChain() {
    const net = state.net;
    const hex = `0x${net.chainId.toString(16)}`;
    const current = await window.ethereum.request({ method: "eth_chainId" });
    if (parseInt(current, 16) === net.chainId) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      const code = e && (e.code !== undefined ? e.code : e.data && e.data.originalError && e.data.originalError.code);
      if (code !== 4902) throw e;
      const params = {
        chainId: hex,
        chainName: net.name,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: [net.rpc],
      };
      if (net.explorer) params.blockExplorerUrls = [net.explorer];
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
    }
  }

  async function connectWallet() {
    if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask, Rabby or another EVM wallet, then reload.");
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    const browser = new ethers.BrowserProvider(window.ethereum, "any");
    state.signer = await browser.getSigner();
    state.account = await state.signer.getAddress();
    $("btn-connect").textContent = short(state.account);
    return state.account;
  }

  // ------------------------------------------------------------------ create invoice

  function readDue() {
    const v = $("in-due").value;
    if (v === "0") return 0n;
    const now = Math.floor(Date.now() / 1000);
    if (v === "custom") {
      const s = $("in-due-custom").value;
      if (!s) throw new Error("Pick a date and time for the deadline.");
      const t = Math.floor(new Date(s).getTime() / 1000);
      if (!(t > now)) throw new Error("The deadline must be in the future.");
      return BigInt(t);
    }
    return BigInt(now + Number(v));
  }

  function buildPayUrl(inv) {
    const p = new URLSearchParams({
      c: String(state.net.chainId),
      m: inv.merchant,
      a: fmtUsdc(inv.amountWei),
      d: inv.dueBy.toString(),
      s: inv.salt,
      n: inv.memo,
    });
    return `${window.location.href.split("#")[0]}#/pay?${p.toString()}`;
  }

  async function onCreate(ev) {
    ev.preventDefault();
    hide("create-error");
    try {
      if (!isDeployed()) throw new Error(`PayLink is not deployed on ${state.net.name} yet.`);
      const raw = $("in-merchant").value.trim();
      if (!ethers.isAddress(raw)) throw new Error("Enter a valid recipient address (0x…).");
      const merchant = ethers.getAddress(raw);
      if (merchant === ZERO) throw new Error("The zero address cannot receive payments.");
      const amountWei = parseAmount($("in-amount").value);
      const memo = $("in-memo").value.trim();
      if (memoBytes(memo) > MAX_MEMO_BYTES) throw new Error("The memo is longer than 140 bytes.");
      const dueBy = readDue();
      const salt = ethers.hexlify(ethers.randomBytes(32));
      const inv = { merchant, amountWei, dueBy, salt, memo };
      const id = computeInvoiceId(inv);
      const url = buildPayUrl(inv);

      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      $("qr-img").src = qr.createDataURL(6, 2);
      $("out-link").value = url;
      $("out-open").href = url;
      setText("out-id", id);
      setText("out-amount", `${fmtUsdc(amountWei)} USDC`);
      setText("out-due", dueBy === 0n ? "No deadline" : fmtTime(dueBy));
      const ws = showStatus("watch-status", "", "Waiting for payment… this card updates by itself.");
      $("create-result").hidden = false;
      $("create-result").scrollIntoView({ behavior: "smooth", block: "start" });

      startPoll(async () => {
        const r = await state.contract.receiptOf(id);
        if (r.payer === ZERO) return false;
        const log = await findPaidLog(id, r.blockNumber).catch(() => null);
        ws.className = "status ok";
        ws.textContent = `Paid ✓ ${fmtUsdc(r.amount)} USDC by ${short(r.payer)} at ${fmtTime(r.paidAt)}. `;
        if (log) {
          const span = document.createElement("span");
          linkOrText(span, explorerTx(log.txHash), `tx ${short(log.txHash)}`);
          ws.appendChild(span);
        }
        return true;
      }, 1000);
    } catch (e) {
      showStatus("create-error", "err", friendlyError(e));
    }
  }

  async function copyLink() {
    const input = $("out-link");
    try {
      await navigator.clipboard.writeText(input.value);
      toast("Link copied");
    } catch (_) {
      input.select();
      document.execCommand("copy");
      toast("Link copied");
    }
  }

  // ------------------------------------------------------------------ pay invoice

  function parseInvoice(params) {
    const m = params.get("m");
    const s = params.get("s");
    const d = params.get("d") || "0";
    const n = params.get("n") || "";
    if (!m || !ethers.isAddress(m)) throw new Error("This link has no valid recipient.");
    if (!s || !/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error("This link is malformed (salt).");
    if (!/^\d{1,20}$/.test(d)) throw new Error("This link is malformed (deadline).");
    if (memoBytes(n) > MAX_MEMO_BYTES) throw new Error("This link is malformed (memo too long).");
    return { merchant: ethers.getAddress(m), amountWei: parseAmount(params.get("a")), dueBy: BigInt(d), salt: s.toLowerCase(), memo: n };
  }

  function setPill(kind, text) {
    const p = $("pay-pill");
    p.className = `pill ${kind}`;
    p.textContent = text;
  }

  async function findPaidLog(id, blockNumber) {
    const bn = Number(blockNumber);
    const logs = await state.read.getLogs({ address: state.net.payLink, topics: [TOPIC_PAID, id], fromBlock: bn, toBlock: bn });
    if (!logs.length) return null;
    const parsed = iface.parseLog(logs[0]);
    return { txHash: logs[0].transactionHash, memo: parsed.args.memo };
  }

  async function showReceipt(id, r) {
    $("pay-receipt").hidden = false;
    linkOrText($("rc-payer"), explorerAddr(r.payer), r.payer);
    setText("rc-time", fmtTime(r.paidAt));
    setText("rc-block", r.blockNumber.toString());
    const log = await findPaidLog(id, r.blockNumber).catch(() => null);
    if (log) linkOrText($("rc-tx"), explorerTx(log.txHash), log.txHash);
    else setText("rc-tx", "—");
  }

  async function refreshPayState() {
    const inv = state.invoice;
    const btn = $("btn-pay");
    const r = await state.contract.receiptOf(inv.id);
    if (r.payer !== ZERO) {
      setPill("paid", "Paid");
      btn.disabled = true;
      btn.textContent = "Paid";
      await showReceipt(inv.id, r);
      return true;
    }
    if (inv.dueBy !== 0n && BigInt(Math.floor(Date.now() / 1000)) > inv.dueBy) {
      setPill("expired", "Expired");
      btn.disabled = true;
      return false;
    }
    setPill("unpaid", "Unpaid");
    btn.disabled = false;
    return false;
  }

  async function estimateFee() {
    try {
      const gasPrice = BigInt(await state.read.send("eth_gasPrice", []));
      const v = Number(ethers.formatUnits(TYPICAL_PAY_GAS * gasPrice, NATIVE_DECIMALS));
      setText("pay-fee", `≈ $${v < 0.0001 ? "0.0001" : v.toFixed(4)} — paid in USDC, no other token needed`);
    } catch (_) {
      setText("pay-fee", "—");
    }
  }

  async function renderPay(params) {
    const btn = $("btn-pay");
    btn.disabled = true;
    hide("pay-status");
    $("pay-receipt").hidden = true;
    let inv;
    try {
      inv = parseInvoice(params);
    } catch (e) {
      setPill("expired", "Invalid link");
      showStatus("pay-status", "err", friendlyError(e));
      return;
    }
    state.invoice = inv;
    const amountEl = $("pay-amount");
    amountEl.textContent = `${fmtUsdc(inv.amountWei)} `;
    const small = document.createElement("small");
    small.textContent = "USDC";
    amountEl.appendChild(small);
    linkOrText($("pay-merchant"), explorerAddr(inv.merchant), inv.merchant);
    setText("pay-memo", inv.memo || "—");
    setText("pay-due", inv.dueBy === 0n ? "No deadline" : fmtTime(inv.dueBy));
    setText("pay-network", `${state.net.name} (chain id ${state.net.chainId})`);
    if (!isDeployed()) {
      setPill("expired", "Unavailable");
      showStatus("pay-status", "warn", `PayLink is not deployed on ${state.net.name} yet.`);
      return;
    }
    inv.id = computeInvoiceId(inv);
    setText("pay-id", inv.id);
    btn.textContent = `Pay ${fmtUsdc(inv.amountWei)} USDC`;
    estimateFee();
    startPoll(refreshPayState, 2000);
  }

  async function waitReceipt(hash, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rc = await state.read.getTransactionReceipt(hash).catch(() => null);
      if (rc) return rc;
      await sleep(250);
    }
    throw new Error("Timed out waiting for the transaction — check it in the explorer.");
  }

  async function onPay() {
    const inv = state.invoice;
    const btn = $("btn-pay");
    btn.disabled = true;
    stopPoll();
    try {
      if (!state.signer) await connectWallet();
      else await ensureChain();
      const c = new ethers.Contract(state.net.payLink, ABI, state.signer);
      showStatus("pay-status", "", "Checking the invoice…");
      await c.pay.staticCall(inv.merchant, inv.amountWei, inv.dueBy, inv.salt, inv.memo, { value: inv.amountWei });
      showStatus("pay-status", "", "Confirm the payment in your wallet…");
      const tx = await c.pay(inv.merchant, inv.amountWei, inv.dueBy, inv.salt, inv.memo, { value: inv.amountWei });
      const t0 = performance.now();
      showStatus("pay-status", "", `Sent ${short(tx.hash)} — waiting for finality…`);
      const rc = await waitReceipt(tx.hash);
      const secs = ((performance.now() - t0) / 1000).toFixed(2);
      if (rc.status !== 1) throw new Error("The transaction reverted. Nothing was charged except the network fee.");
      showStatus("pay-status", "ok", `Paid ✓ Final in ${secs} s — on Arc one confirmation is final.`);
      await refreshPayState();
    } catch (e) {
      showStatus("pay-status", "err", friendlyError(e));
      await refreshPayState().catch(() => {});
    }
  }

  // ------------------------------------------------------------------ dashboard

  function renderRows(rows) {
    const tbody = $("dash-rows");
    tbody.textContent = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      const cells = [fmtTime(r.paidAt), `${fmtUsdc(r.amount)} USDC`, r.memo || "—"];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      const tdPayer = document.createElement("td");
      tdPayer.className = "mono";
      linkOrText(tdPayer, explorerAddr(r.payer), short(r.payer));
      tr.appendChild(tdPayer);
      const tdTx = document.createElement("td");
      tdTx.className = "mono";
      if (r.tx) linkOrText(tdTx, explorerTx(r.tx), short(r.tx)); else tdTx.textContent = "—";
      tr.appendChild(tdTx);
      tbody.appendChild(tr);
    }
  }

  async function loadDashboard(addr) {
    hide("dash-error");
    $("dash-rows").textContent = "";
    $("btn-csv").disabled = true;
    try {
      if (!isDeployed()) throw new Error(`PayLink is not deployed on ${state.net.name} yet.`);
      if (!ethers.isAddress(addr)) throw new Error("Enter a valid merchant address.");
      const merchant = ethers.getAddress(addr);
      const { params } = parseHash();
      if (params.get("m") !== merchant) {
        history.replaceState(null, "", `#/dashboard?m=${merchant}`);
      }
      const count = await state.contract.paidInvoiceCount(merchant);
      setText("st-count", count.toString());
      const PAGE = 50n;
      const offset = count > PAGE ? count - PAGE : 0n;
      const ids = count === 0n ? [] : [...(await state.contract.paidInvoicesOf(merchant, offset, PAGE))].reverse();
      const rows = await mapLimit(ids, 4, async (id) => {
        const r = await state.contract.receiptOf(id);
        const log = await findPaidLog(id, r.blockNumber).catch(() => null);
        return { id, payer: r.payer, amount: r.amount, paidAt: r.paidAt, block: r.blockNumber, memo: log ? log.memo : "", tx: log ? log.txHash : "" };
      });
      state.dashRows = rows;
      renderRows(rows);
      const total = rows.reduce((s, r) => s + r.amount, 0n);
      setText("st-total", fmtUsdc(total));
      setText("st-last", rows.length ? fmtTime(rows[0].paidAt) : "—");
      $("btn-csv").disabled = rows.length === 0;
    } catch (e) {
      showStatus("dash-error", "err", friendlyError(e));
    }
  }

  function csvCell(v) {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas coming from memos
    return `"${s.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const header = ["invoice_id", "paid_at_utc", "amount_usdc", "payer", "memo", "tx_hash", "block"];
    const lines = [header.join(",")];
    for (const r of state.dashRows) {
      lines.push([r.id, new Date(Number(r.paidAt) * 1000).toISOString(), fmtUsdc(r.amount), r.payer, r.memo, r.tx, r.block.toString()].map(csvCell).join(","));
    }
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `paylink-${state.net.chainId}-payments.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------ routing

  function route() {
    stopPoll();
    initNetwork();
    const { path, params } = parseHash();
    for (const v of ["create", "pay", "dashboard"]) $(`view-${v}`).hidden = true;
    document.querySelectorAll("nav a").forEach((a) => a.classList.remove("active"));
    const activate = (name) => {
      const a = document.querySelector(`nav a[data-nav="${name}"]`);
      if (a) a.classList.add("active");
    };
    if (path.startsWith("/pay")) {
      $("view-pay").hidden = false;
      renderPay(params);
    } else if (path.startsWith("/dashboard")) {
      $("view-dashboard").hidden = false;
      activate("dashboard");
      const m = params.get("m") || state.account || "";
      $("in-dash-merchant").value = m;
      if (m) loadDashboard(m);
    } else {
      $("view-create").hidden = false;
      $("create-result").hidden = true;
      activate("create");
    }
  }

  function init() {
    if (!ethers || !CFG) {
      document.body.textContent = "Failed to load PayLink scripts.";
      return;
    }
    $("btn-connect").addEventListener("click", () => connectWallet().catch((e) => toast(friendlyError(e))));
    $("btn-use-wallet").addEventListener("click", async () => {
      try {
        $("in-merchant").value = await connectWallet();
      } catch (e) {
        showStatus("create-error", "err", friendlyError(e));
      }
    });
    $("form-create").addEventListener("submit", onCreate);
    $("in-due").addEventListener("change", () => { $("in-due-custom").hidden = $("in-due").value !== "custom"; });
    $("btn-copy").addEventListener("click", copyLink);
    $("btn-pay").addEventListener("click", onPay);
    $("form-dash").addEventListener("submit", (e) => {
      e.preventDefault();
      loadDashboard($("in-dash-merchant").value.trim());
    });
    $("btn-csv").addEventListener("click", exportCsv);
    window.addEventListener("hashchange", route);
    if (window.ethereum && typeof window.ethereum.on === "function") {
      window.ethereum.on("accountsChanged", (accs) => {
        state.signer = null;
        state.account = accs && accs[0] ? ethers.getAddress(accs[0]) : null;
        $("btn-connect").textContent = state.account ? short(state.account) : "Connect wallet";
      });
      window.ethereum.on("chainChanged", () => { state.signer = null; });
    }
    route();
  }

  init();
})();

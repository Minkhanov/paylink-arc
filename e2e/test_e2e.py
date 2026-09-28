"""PayLink end-to-end scenario on a local anvil node, driven through the real web UI.

    python e2e/test_e2e.py            # needs Foundry + `pip install playwright`

Flow: deploy -> merchant creates an invoice link (no transaction) -> payer opens the link and
pays in one transaction -> merchant card flips to "Paid" by itself -> dashboard lists the payment
-> the same link cannot be paid twice. Screenshots go to docs/screenshots/.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse

from playwright.sync_api import expect, sync_playwright

from harness import (DEV_ACCOUNTS, ROOT, WEB_PORT, Anvil, WebServer, cast, forge_script,
                     launch_browser, parse_address, rpc, wallet_shim)

EXPECTED_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3"  # matches web/config.js (31337)
DEPLOYER = DEV_ACCOUNTS[0]
MERCHANT = DEV_ACCOUNTS[2][0]
PAYER = DEV_ACCOUNTS[3][0]
AMOUNT = "12.5"
MEMO = "Invoice #42 — logo design"
SHOTS = ROOT / "docs" / "screenshots"


def balance(addr: str) -> int:
    return int(rpc("eth_getBalance", [addr, "latest"]), 16)


def main() -> int:
    SHOTS.mkdir(parents=True, exist_ok=True)
    results: dict = {}
    with Anvil(), WebServer(ROOT / "web"), sync_playwright() as p:
        out = forge_script("script/Deploy.s.sol:Deploy", DEPLOYER[1])
        address = parse_address(out, "PayLink deployed at:")
        assert address.lower() == EXPECTED_ADDRESS.lower(), address
        results["contract"] = address

        browser = launch_browser(p)
        errors: list[str] = []

        def new_page(account: str):
            ctx = browser.new_context(viewport={"width": 1100, "height": 900})
            ctx.add_init_script(wallet_shim(account))
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.on("response", lambda r: errors.append(f"HTTP {r.status}: {r.url}") if r.status >= 400 else None)
            return page

        base = f"http://127.0.0.1:{WEB_PORT}/?chain=31337"

        # 1. Merchant creates the invoice (no transaction).
        merchant = new_page(MERCHANT)
        merchant.goto(f"{base}#/")
        expect(merchant.locator("#net-badge")).to_have_text("Local Anvil")
        merchant.click("#btn-use-wallet")
        expect(merchant.locator("#in-merchant")).to_have_value(MERCHANT)
        merchant.fill("#in-amount", AMOUNT)
        merchant.fill("#in-memo", MEMO)
        merchant.select_option("#in-due", "604800")
        block_before = int(rpc("eth_blockNumber"), 16)
        merchant.click("#btn-create")
        expect(merchant.locator("#create-result")).to_be_visible()
        link = merchant.locator("#out-link").input_value()
        assert "#/pay?" in link, link
        assert merchant.locator("#qr-img").get_attribute("src").startswith("data:image/"), "QR missing"
        assert int(rpc("eth_blockNumber"), 16) == block_before, "creating an invoice must not send a transaction"
        expect(merchant.locator("#watch-status")).to_contain_text("Waiting for payment")
        merchant.screenshot(path=str(SHOTS / "01-create-invoice.png"), full_page=True)

        # The id computed in JavaScript must equal the one computed by the contract.
        q = urllib.parse.parse_qs(link.split("#/pay?")[1])
        js_id = merchant.locator("#out-id").inner_text().strip()
        sol_id = cast("call", address, "computeInvoiceId(address,uint256,uint64,bytes32,string)(bytes32)",
                      q["m"][0], "12500000000000000000", q["d"][0], q["s"][0], q["n"][0])
        assert js_id.lower() == sol_id.lower(), (js_id, sol_id)
        results["invoice_id_matches_contract"] = True

        # 2. Payer opens the link and pays in one transaction.
        payer = new_page(PAYER)
        payer.goto(link)
        expect(payer.locator("#pay-pill")).to_have_text("Unpaid")
        expect(payer.locator("#pay-amount")).to_contain_text("12.5")
        expect(payer.locator("#pay-memo")).to_have_text(MEMO)
        expect(payer.locator("#btn-pay")).to_have_text("Pay 12.5 USDC")
        expect(payer.locator("#pay-fee")).to_contain_text("$")
        payer.screenshot(path=str(SHOTS / "02-pay-page.png"), full_page=True)

        m_before, p_before = balance(MERCHANT), balance(PAYER)
        payer.click("#btn-pay")
        expect(payer.locator("#pay-status")).to_have_class("status ok", timeout=20000)
        results["payer_status"] = payer.locator("#pay-status").inner_text()
        expect(payer.locator("#pay-pill")).to_have_text("Paid")
        expect(payer.locator("#rc-payer")).to_have_text(PAYER)
        payer.screenshot(path=str(SHOTS / "03-paid-receipt.png"), full_page=True)

        m_after, p_after = balance(MERCHANT), balance(PAYER)
        assert m_after - m_before == 12_500_000_000_000_000_000, "merchant must receive exactly 12.5"
        spent = p_before - p_after
        fee = spent - 12_500_000_000_000_000_000
        assert 0 < fee < 10**16, f"unexpected fee {fee}"
        assert balance(address) == 0, "contract must not hold funds"
        results["merchant_received_wei"] = str(m_after - m_before)
        results["payer_gas_fee_wei"] = str(fee)

        # Gas used by pay() (for the fee estimate in the UI and in the README).
        pay_logs = json.loads(cast("logs", "--from-block", "0", "--address", address, "--json"))
        tx_hash = pay_logs[-1]["transactionHash"]
        rc = json.loads(cast("receipt", tx_hash, "--json"))
        results["pay_gas_used"] = int(rc["gasUsed"], 16)

        # 3. Merchant's card flips to Paid without a reload.
        expect(merchant.locator("#watch-status")).to_have_class("status ok", timeout=10000)
        expect(merchant.locator("#watch-status")).to_contain_text("Paid")
        merchant.screenshot(path=str(SHOTS / "04-merchant-notified.png"), full_page=True)

        # 4. Dashboard reads the on-chain index.
        merchant.goto(f"{base}#/dashboard?m={MERCHANT}")
        expect(merchant.locator("#dash-rows tr")).to_have_count(1, timeout=10000)
        expect(merchant.locator("#dash-rows")).to_contain_text(MEMO)
        expect(merchant.locator("#st-count")).to_have_text("1")
        expect(merchant.locator("#st-total")).to_have_text("12.5")
        merchant.screenshot(path=str(SHOTS / "05-dashboard.png"), full_page=True)

        # 5. The same link cannot be paid twice.
        payer2 = new_page(DEV_ACCOUNTS[4][0])
        payer2.goto(link)
        expect(payer2.locator("#pay-pill")).to_have_text("Paid")
        expect(payer2.locator("#btn-pay")).to_be_disabled()

        # 6. A tampered link (amount changed) is a different invoice and does not show as paid.
        tampered = link.replace("a=12.5", "a=1")
        payer2.goto(tampered)
        payer2.reload()
        expect(payer2.locator("#pay-pill")).to_have_text("Unpaid")

        browser.close()
        real_errors = [e for e in errors if "favicon" not in e]
        assert not real_errors, real_errors
        results["browser_errors"] = 0

    print(json.dumps(results, indent=2, ensure_ascii=False))
    print("E2E OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

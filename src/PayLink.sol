// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PayLink — one-transaction USDC invoices for Arc
/// @notice A merchant creates an invoice off-chain as a plain link (merchant, amount, due date,
///         salt, memo) — creating an invoice costs nothing. A payer settles it in ONE transaction by
///         sending native USDC (Arc's gas token) as `msg.value`: no ERC-20 approval step.
///         The contract forwards the funds to the merchant in the same call, stores an on-chain
///         receipt keyed by the invoice id and rejects any second payment of the same invoice.
/// @dev    Design notes for Arc:
///         - On Arc `msg.value` is USDC with 18 decimals (the ERC-20 view at 0x3600…0000 uses 6).
///           `amount` is therefore an 18-decimal value; the web app restricts input to 6 decimals.
///         - The contract never holds funds: there is no `receive`/`fallback`, and every accepted
///           payment is forwarded to the merchant before the call returns.
///         - A native transfer on Arc can revert even with sufficient balance (blocklist, zero
///           address). In that case the whole payment reverts and the payer keeps the funds.
///         - Deterministic sub-second finality means a stored receipt is final as soon as the
///           transaction is included; merchants can release goods immediately.
contract PayLink {
    /// @notice Maximum memo length in bytes (keeps calldata and event size bounded).
    uint256 public constant MAX_MEMO_BYTES = 140;

    struct Receipt {
        address payer; // who paid
        uint64 paidAt; // block.timestamp of the payment
        address merchant; // who received the funds
        uint64 blockNumber; // block that contains the payment (lets clients fetch the event cheaply)
        uint256 amount; // native USDC, 18 decimals
    }

    /// @dev invoiceId => receipt (payer == address(0) means "unpaid").
    mapping(bytes32 => Receipt) private _receipts;

    /// @dev merchant => invoice ids in the order they were paid (an on-chain index, no indexer needed).
    mapping(address => bytes32[]) private _paidByMerchant;

    /// @notice Emitted once per settled invoice.
    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64 dueBy,
        bytes32 salt,
        string memo
    );

    error InvalidMerchant();
    error ZeroAmount();
    error WrongAmount(uint256 expected, uint256 sent);
    error InvoiceExpired(uint64 dueBy);
    error MemoTooLong(uint256 length);
    error AlreadyPaid(bytes32 invoiceId);
    error ForwardFailed();

    /// @notice Deterministic invoice id. Binds chain, this contract, the merchant, the exact amount,
    ///         the due date, a random salt and the memo, so a link cannot be altered without
    ///         producing a different id.
    function computeInvoiceId(address merchant, uint256 amount, uint64 dueBy, bytes32 salt, string calldata memo)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(block.chainid, address(this), merchant, amount, dueBy, salt, keccak256(bytes(memo)))
        );
    }

    /// @notice Pay an invoice with native USDC. `msg.value` must equal `amount` exactly.
    /// @param merchant Recipient of the funds.
    /// @param amount   Invoice amount, native USDC (18 decimals).
    /// @param dueBy    Unix timestamp after which the invoice can no longer be paid; 0 = no expiry.
    /// @param salt     Random 32 bytes chosen by the merchant to make every invoice unique.
    /// @param memo     Human-readable reference, e.g. "Invoice #42 — logo design" (<= 140 bytes).
    /// @return invoiceId The id under which the receipt is stored.
    function pay(address payable merchant, uint256 amount, uint64 dueBy, bytes32 salt, string calldata memo)
        external
        payable
        returns (bytes32 invoiceId)
    {
        if (merchant == address(0)) revert InvalidMerchant();
        if (amount == 0) revert ZeroAmount();
        if (msg.value != amount) revert WrongAmount(amount, msg.value);
        // Due dates are coarse (minutes/days); proposer timestamp skew is irrelevant here.
        // forge-lint: disable-next-line(block-timestamp)
        if (dueBy != 0 && block.timestamp > dueBy) revert InvoiceExpired(dueBy);
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong(bytes(memo).length);

        invoiceId = computeInvoiceId(merchant, amount, dueBy, salt, memo);
        if (_receipts[invoiceId].payer != address(0)) revert AlreadyPaid(invoiceId);

        // Effects and event before the interaction (checks-effects-interactions): a re-entrant
        // call for the same invoice sees it as paid, and logs cannot be reordered by the merchant.
        _receipts[invoiceId] = Receipt({
            payer: msg.sender,
            // uint64 holds timestamps/block numbers for billions of years.
            // forge-lint: disable-next-line(unsafe-typecast)
            paidAt: uint64(block.timestamp),
            merchant: merchant,
            // forge-lint: disable-next-line(unsafe-typecast)
            blockNumber: uint64(block.number),
            amount: amount
        });
        _paidByMerchant[merchant].push(invoiceId);
        emit InvoicePaid(invoiceId, merchant, msg.sender, amount, dueBy, salt, memo);

        // Paying the merchant named in the invoice is the whole point of this call; the amount is
        // exactly msg.value, so the contract can never send out more than it just received.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        (bool ok,) = merchant.call{value: amount}("");
        if (!ok) revert ForwardFailed();
    }

    // ------------------------------------------------------------------ views

    /// @notice Full receipt for an invoice id (all zero if unpaid).
    function receiptOf(bytes32 invoiceId) external view returns (Receipt memory) {
        return _receipts[invoiceId];
    }

    /// @notice True once the invoice has been paid.
    function isPaid(bytes32 invoiceId) external view returns (bool) {
        return _receipts[invoiceId].payer != address(0);
    }

    /// @notice Number of invoices paid to `merchant`.
    function paidInvoiceCount(address merchant) external view returns (uint256) {
        return _paidByMerchant[merchant].length;
    }

    /// @notice Page through the invoice ids paid to `merchant` (oldest first).
    function paidInvoicesOf(address merchant, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory ids)
    {
        bytes32[] storage all = _paidByMerchant[merchant];
        if (offset >= all.length) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        ids = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = all[i];
        }
    }
}

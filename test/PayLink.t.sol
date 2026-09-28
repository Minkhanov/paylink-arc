// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayLink} from "../src/PayLink.sol";

/// @dev Merchant contract that cannot receive native USDC.
contract RejectingMerchant {}

/// @dev Merchant contract that tries to pay the same invoice again from inside `receive`.
contract ReentrantMerchant {
    PayLink public immutable payLink;
    uint64 public dueBy;
    bytes32 public salt;
    string public memo;
    bool public reentryReverted;
    bytes public reentryError;

    constructor(PayLink _payLink) {
        payLink = _payLink;
    }

    function arm(uint64 _dueBy, bytes32 _salt, string calldata _memo) external {
        dueBy = _dueBy;
        salt = _salt;
        memo = _memo;
    }

    receive() external payable {
        if (reentryError.length > 0 || reentryReverted) return;
        try payLink.pay{value: msg.value}(payable(address(this)), msg.value, dueBy, salt, memo) {
        // must never happen
        }
        catch (bytes memory err) {
            reentryReverted = true;
            reentryError = err;
        }
    }
}

contract PayLinkTest is Test {
    PayLink internal payLink;

    address payable internal merchant = payable(makeAddr("merchant"));
    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE_USDC = 1e18; // native USDC on Arc has 18 decimals
    uint256 internal constant AMOUNT = 12_500_000_000_000_000_000; // 12.5 USDC
    bytes32 internal constant SALT = keccak256("salt-1");
    string internal constant MEMO = "Invoice #42 - logo design";

    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint64 dueBy,
        bytes32 salt,
        string memo
    );

    function setUp() public {
        payLink = new PayLink();
        vm.deal(payer, 1_000 * ONE_USDC);
        vm.deal(stranger, 1_000 * ONE_USDC);
        vm.warp(1_790_000_000);
    }

    function _pay(address from, uint256 value, uint64 dueBy, bytes32 salt, string memory memo)
        internal
        returns (bytes32)
    {
        vm.prank(from);
        return payLink.pay{value: value}(merchant, value, dueBy, salt, memo);
    }

    // ------------------------------------------------------------ happy path

    function test_PayForwardsFundsAndStoresReceipt() public {
        uint256 merchantBefore = merchant.balance;
        uint256 payerBefore = payer.balance;

        bytes32 id = _pay(payer, AMOUNT, 0, SALT, MEMO);

        assertEq(merchant.balance - merchantBefore, AMOUNT, "merchant credited");
        assertEq(payerBefore - payer.balance, AMOUNT, "payer debited");
        assertEq(address(payLink).balance, 0, "contract holds no funds");

        PayLink.Receipt memory r = payLink.receiptOf(id);
        assertEq(r.payer, payer);
        assertEq(r.merchant, merchant);
        assertEq(r.amount, AMOUNT);
        assertEq(r.paidAt, block.timestamp);
        assertEq(r.blockNumber, block.number);
        assertTrue(payLink.isPaid(id));
    }

    function test_ReturnedIdMatchesComputedId() public {
        uint64 dueBy = uint64(block.timestamp + 1 days);
        bytes32 expected = payLink.computeInvoiceId(merchant, AMOUNT, dueBy, SALT, MEMO);
        assertFalse(payLink.isPaid(expected));
        bytes32 id = _pay(payer, AMOUNT, dueBy, SALT, MEMO);
        assertEq(id, expected);
        assertTrue(payLink.isPaid(expected));
    }

    function test_EmitsInvoicePaid() public {
        bytes32 expected = payLink.computeInvoiceId(merchant, AMOUNT, 0, SALT, MEMO);
        vm.expectEmit(true, true, true, true, address(payLink));
        emit InvoicePaid(expected, merchant, payer, AMOUNT, 0, SALT, MEMO);
        _pay(payer, AMOUNT, 0, SALT, MEMO);
    }

    function test_AnyoneCanPayOnBehalf() public {
        bytes32 id = _pay(stranger, AMOUNT, 0, SALT, MEMO);
        assertEq(payLink.receiptOf(id).payer, stranger);
    }

    function test_PayOnDueDateIsAllowed() public {
        uint64 dueBy = uint64(block.timestamp);
        bytes32 id = _pay(payer, AMOUNT, dueBy, SALT, MEMO);
        assertTrue(payLink.isPaid(id));
    }

    function test_NoExpiryWhenDueByIsZero() public {
        vm.warp(vm.getBlockTimestamp() + 3650 days);
        bytes32 id = _pay(payer, AMOUNT, 0, SALT, MEMO);
        assertTrue(payLink.isPaid(id));
    }

    function test_MemoAtMaxLengthIsAccepted() public {
        string memory memo = string(new bytes(payLink.MAX_MEMO_BYTES()));
        bytes32 id = _pay(payer, AMOUNT, 0, SALT, memo);
        assertTrue(payLink.isPaid(id));
    }

    // ------------------------------------------------------------ reverts

    function test_RevertWhen_UnderpaidOrOverpaid() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PayLink.WrongAmount.selector, AMOUNT, AMOUNT - 1));
        payLink.pay{value: AMOUNT - 1}(merchant, AMOUNT, 0, SALT, MEMO);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PayLink.WrongAmount.selector, AMOUNT, AMOUNT + 1));
        payLink.pay{value: AMOUNT + 1}(merchant, AMOUNT, 0, SALT, MEMO);
    }

    function test_RevertWhen_ZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(PayLink.ZeroAmount.selector);
        payLink.pay{value: 0}(merchant, 0, 0, SALT, MEMO);
    }

    function test_RevertWhen_ZeroMerchant() public {
        vm.prank(payer);
        vm.expectRevert(PayLink.InvalidMerchant.selector);
        payLink.pay{value: AMOUNT}(payable(address(0)), AMOUNT, 0, SALT, MEMO);
    }

    function test_RevertWhen_Expired() public {
        uint64 dueBy = uint64(vm.getBlockTimestamp() + 1 hours);
        vm.warp(dueBy + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PayLink.InvoiceExpired.selector, dueBy));
        payLink.pay{value: AMOUNT}(merchant, AMOUNT, dueBy, SALT, MEMO);
    }

    function test_RevertWhen_MemoTooLong() public {
        uint256 len = payLink.MAX_MEMO_BYTES() + 1;
        string memory memo = string(new bytes(len));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PayLink.MemoTooLong.selector, len));
        payLink.pay{value: AMOUNT}(merchant, AMOUNT, 0, SALT, memo);
    }

    function test_RevertWhen_AlreadyPaid() public {
        bytes32 id = _pay(payer, AMOUNT, 0, SALT, MEMO);
        uint256 merchantAfterFirst = merchant.balance;

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PayLink.AlreadyPaid.selector, id));
        payLink.pay{value: AMOUNT}(merchant, AMOUNT, 0, SALT, MEMO);

        assertEq(merchant.balance, merchantAfterFirst, "no second credit");
        assertEq(payLink.paidInvoiceCount(merchant), 1);
    }

    function test_RevertWhen_MerchantRejectsFunds_PayerKeepsMoney() public {
        RejectingMerchant bad = new RejectingMerchant();
        uint256 payerBefore = payer.balance;
        vm.prank(payer);
        vm.expectRevert(PayLink.ForwardFailed.selector);
        payLink.pay{value: AMOUNT}(payable(address(bad)), AMOUNT, 0, SALT, MEMO);
        assertEq(payer.balance, payerBefore);
        assertEq(address(payLink).balance, 0);
    }

    function test_RevertWhen_PlainTransferToContract() public {
        vm.prank(payer);
        (bool ok,) = address(payLink).call{value: AMOUNT}("");
        assertFalse(ok, "contract must not accept stray USDC");
    }

    function test_ReentrantMerchantCannotDoublePay() public {
        ReentrantMerchant m = new ReentrantMerchant(payLink);
        m.arm(0, SALT, MEMO);
        vm.deal(address(m), 0);

        vm.prank(payer);
        bytes32 id = payLink.pay{value: AMOUNT}(payable(address(m)), AMOUNT, 0, SALT, MEMO);

        assertTrue(m.reentryReverted(), "re-entry attempted and failed");
        assertEq(m.reentryError(), abi.encodeWithSelector(PayLink.AlreadyPaid.selector, id));
        assertEq(address(m).balance, AMOUNT, "merchant received exactly one payment");
        assertEq(payLink.paidInvoiceCount(address(m)), 1);
    }

    // ------------------------------------------------------------ id binding

    function test_AnyFieldChangeGivesDifferentId() public view {
        bytes32 base = payLink.computeInvoiceId(merchant, AMOUNT, 0, SALT, MEMO);
        assertTrue(base != payLink.computeInvoiceId(payable(stranger), AMOUNT, 0, SALT, MEMO));
        assertTrue(base != payLink.computeInvoiceId(merchant, AMOUNT + 1, 0, SALT, MEMO));
        assertTrue(base != payLink.computeInvoiceId(merchant, AMOUNT, 1, SALT, MEMO));
        assertTrue(base != payLink.computeInvoiceId(merchant, AMOUNT, 0, bytes32(uint256(SALT) + 1), MEMO));
        assertTrue(base != payLink.computeInvoiceId(merchant, AMOUNT, 0, SALT, "Invoice #43 - logo design"));
    }

    function test_IdIsBoundToChainAndContract() public {
        bytes32 onThisChain = payLink.computeInvoiceId(merchant, AMOUNT, 0, SALT, MEMO);
        PayLink other = new PayLink();
        assertTrue(onThisChain != other.computeInvoiceId(merchant, AMOUNT, 0, SALT, MEMO));
        vm.chainId(5042);
        assertTrue(onThisChain != payLink.computeInvoiceId(merchant, AMOUNT, 0, SALT, MEMO));
    }

    // ------------------------------------------------------------ merchant index

    function test_PaidInvoicesPagination() public {
        bytes32[] memory ids = new bytes32[](5);
        for (uint256 i = 0; i < 5; i++) {
            ids[i] = _pay(payer, ONE_USDC * (i + 1), 0, bytes32(i + 1), MEMO);
        }
        assertEq(payLink.paidInvoiceCount(merchant), 5);

        bytes32[] memory page1 = payLink.paidInvoicesOf(merchant, 0, 2);
        assertEq(page1.length, 2);
        assertEq(page1[0], ids[0]);
        assertEq(page1[1], ids[1]);

        bytes32[] memory page3 = payLink.paidInvoicesOf(merchant, 4, 2);
        assertEq(page3.length, 1);
        assertEq(page3[0], ids[4]);

        assertEq(payLink.paidInvoicesOf(merchant, 5, 2).length, 0);
        assertEq(payLink.paidInvoicesOf(stranger, 0, 10).length, 0);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_PayExactAmount(uint96 rawAmount, bytes32 salt, uint32 dueIn) public {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000 * ONE_USDC);
        uint64 dueBy = dueIn == 0 ? 0 : uint64(block.timestamp) + dueIn;
        uint256 before = merchant.balance;
        bytes32 id = _pay(payer, amount, dueBy, salt, MEMO);
        assertEq(merchant.balance - before, amount);
        assertEq(payLink.receiptOf(id).amount, amount);
        assertEq(address(payLink).balance, 0);
    }
}

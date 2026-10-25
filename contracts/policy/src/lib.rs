//! PrivatePay Agent — on-chain spending policy with real FT settlement.
//!
//! The contract is the last line of defence for an AI agent that pays invoices.
//! It holds the token balance, enforces the daily cap and the recipient
//! whitelist, checks that the caller is the configured agent, and performs the
//! `ft_transfer` itself. The agent cannot move the token directly: its Function
//! Call Key is scoped to `try_pay` on this contract, and this contract is the
//! only account with a balance to spend.
//!
//! All amounts are micro-USDC (`u128`, 6 decimals). Nothing sensitive is stored:
//! `invoice_ref` is an opaque reference, never the invoice text.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableSet, Vector};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const RESULT_SUCCESS: &str = "SUCCESS";
const REASON_OVER_LIMIT: &str = "OVER_LIMIT";
const REASON_NOT_WHITELISTED: &str = "NOT_WHITELISTED";
const REASON_DUPLICATE: &str = "DUPLICATE_INVOICE";
const REASON_ZERO_AMOUNT: &str = "ZERO_AMOUNT";
const REASON_INVALID_REF: &str = "INVALID_INVOICE_REF";

const MAX_INVOICE_REF_BYTES: usize = 64;
const DEFAULT_LOG_LIMIT: u32 = 20;
const MAX_LOG_LIMIT: u32 = 100;

const FT_TRANSFER_GAS_TGAS: u64 = 40;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Attempt {
    pub invoice_ref: String,
    pub to: AccountId,
    pub amount_micro_usdc: u128,
    pub result: String,
    pub ts: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PolicyContract {
    owner: AccountId,
    agent_id: AccountId,
    token_id: AccountId,
    daily_cap_micro_usdc: u128,
    spent_today_micro_usdc: u128,
    /// Days since the Unix epoch (UTC). Used to roll the daily counter.
    day: u32,
    whitelist: IterableSet<AccountId>,
    /// Idempotency guard: an invoice reference can be paid at most once.
    paid_invoices: IterableSet<String>,
    log: Vector<Attempt>,
}

#[near]
impl PolicyContract {
    #[init]
    pub fn new(
        owner: AccountId,
        agent_id: AccountId,
        token_id: AccountId,
        cap_micro_usdc: U128,
    ) -> Self {
        require!(
            owner != agent_id,
            "owner and agent must be different accounts"
        );
        Self {
            owner,
            agent_id,
            token_id,
            daily_cap_micro_usdc: cap_micro_usdc.0,
            spent_today_micro_usdc: 0,
            day: current_day(),
            whitelist: IterableSet::new(b"w"),
            paid_invoices: IterableSet::new(b"p"),
            log: Vector::new(b"l"),
        }
    }

    // ---------------------------------------------------------------- policy

    /// Owner only. Overwrites the daily cap.
    pub fn set_daily_cap(&mut self, cap_micro_usdc: U128) -> Value {
        self.assert_owner();
        self.roll_day();
        self.daily_cap_micro_usdc = cap_micro_usdc.0;
        json!({ "ok": true, "cap_micro_usdc": cap_micro_usdc.0.to_string() })
    }

    /// Owner only. Idempotent.
    pub fn add_to_whitelist(&mut self, account_id: AccountId) -> Value {
        self.assert_owner();
        self.whitelist.insert(account_id);
        json!({ "ok": true })
    }

    /// Owner only. No-op if the account is absent.
    pub fn remove_from_whitelist(&mut self, account_id: AccountId) -> Value {
        self.assert_owner();
        self.whitelist.remove(&account_id);
        json!({ "ok": true })
    }

    /// Owner only, demo/ops helper.
    ///
    /// Clears today's spending counter, the idempotency set and the attempt
    /// log so the two-minute demo can be replayed. The agent's Function Call
    /// Key is not permitted to call this method.
    pub fn reset_spent(&mut self) -> Value {
        self.assert_owner();
        self.spent_today_micro_usdc = 0;
        self.day = current_day();
        self.paid_invoices.clear();
        self.log.clear();
        json!({ "ok": true })
    }

    // ------------------------------------------------------------- agent API

    /// The only method the agent's Function Call Key may invoke.
    ///
    /// Never throws for a policy decision: a refused attempt is a normal,
    /// audited outcome returned as `{ ok: false, reason }`. It throws if the
    /// caller is not the configured agent, or if the arguments are malformed.
    pub fn try_pay(
        &mut self,
        to: AccountId,
        amount_micro_usdc: U128,
        invoice_ref: String,
    ) -> Value {
        require!(
            env::predecessor_account_id() == self.agent_id,
            "only the agent may call try_pay"
        );

        let amount = amount_micro_usdc.0;

        if amount == 0 {
            return self.blocked(
                &to,
                amount,
                &invoice_ref,
                REASON_ZERO_AMOUNT,
                "BLOCKED_ZERO_AMOUNT",
            );
        }
        if invoice_ref.is_empty() || invoice_ref.len() > MAX_INVOICE_REF_BYTES {
            return self.blocked(
                &to,
                amount,
                &invoice_ref,
                REASON_INVALID_REF,
                "BLOCKED_INVALID_INVOICE_REF",
            );
        }
        if self.paid_invoices.contains(&invoice_ref) {
            return self.blocked(
                &to,
                amount,
                &invoice_ref,
                REASON_DUPLICATE,
                "BLOCKED_DUPLICATE_INVOICE",
            );
        }

        self.roll_day();

        // The recipient boundary is checked before the amount so an unknown
        // recipient is reported as NOT_WHITELISTED even if it is also over cap.
        if !self.whitelist.contains(&to) {
            return self.blocked(
                &to,
                amount,
                &invoice_ref,
                REASON_NOT_WHITELISTED,
                "BLOCKED_NOT_WHITELISTED",
            );
        }
        if self.spent_today_micro_usdc.saturating_add(amount) > self.daily_cap_micro_usdc {
            return self.blocked(
                &to,
                amount,
                &invoice_ref,
                REASON_OVER_LIMIT,
                "BLOCKED_OVER_LIMIT",
            );
        }

        // Money-path enforcement: the contract records the decision, then makes
        // the FT transfer itself. The agent can never call the FT contract.
        self.spent_today_micro_usdc = self.spent_today_micro_usdc.saturating_add(amount);
        self.paid_invoices.insert(invoice_ref.clone());
        self.record(&invoice_ref, &to, amount, RESULT_SUCCESS);
        emit_payment_event(&invoice_ref, &to, amount, RESULT_SUCCESS, None);

        let _transfer = Promise::new(self.token_id.clone()).function_call(
            "ft_transfer".to_string(),
            json!({
                "receiver_id": to,
                "amount": amount.to_string(),
                "memo": invoice_ref,
            })
            .to_string()
            .into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(FT_TRANSFER_GAS_TGAS),
        );

        json!({
            "ok": true,
            // Policy authorisation receipt. The transaction hash returned by
            // near-api-js also covers the FT transfer receipt.
            "tx": authorisation_id(&to, amount, &invoice_ref),
        })
    }

    // ----------------------------------------------------------------- views

    pub fn get_policy(&self) -> Value {
        let spent = if self.day == current_day() {
            self.spent_today_micro_usdc
        } else {
            0
        };
        json!({
            "owner": self.owner.to_string(),
            "agent_id": self.agent_id.to_string(),
            "token_id": self.token_id.to_string(),
            "cap_micro_usdc": self.daily_cap_micro_usdc.to_string(),
            "spent_today_micro_usdc": spent.to_string(),
            "whitelist": self.whitelist.iter().cloned().collect::<Vec<AccountId>>(),
            "paid_invoices": self.paid_invoices.len(),
        })
    }

    pub fn get_log(&self, limit: Option<u32>) -> Value {
        let limit = limit.unwrap_or(DEFAULT_LOG_LIMIT).min(MAX_LOG_LIMIT);
        let len = self.log.len();
        let start = len.saturating_sub(limit);
        let mut entries = Vec::new();
        for index in start..len {
            if let Some(attempt) = self.log.get(index) {
                entries.push(json!({
                    "invoice_ref": attempt.invoice_ref,
                    "to": attempt.to,
                    "amount_micro_usdc": attempt.amount_micro_usdc.to_string(),
                    "result": attempt.result,
                    "ts": attempt.ts,
                }));
            }
        }
        Value::Array(entries)
    }

    // --------------------------------------------------------------- helpers

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the policy owner may change the policy"
        );
    }

    fn roll_day(&mut self) {
        let today = current_day();
        if self.day != today {
            self.day = today;
            self.spent_today_micro_usdc = 0;
        }
    }

    fn blocked(
        &mut self,
        to: &AccountId,
        amount: u128,
        invoice_ref: &str,
        reason: &str,
        log_result: &str,
    ) -> Value {
        self.record(invoice_ref, to, amount, log_result);
        emit_payment_event(invoice_ref, to, amount, log_result, Some(reason));
        json!({ "ok": false, "reason": reason })
    }

    fn record(&mut self, invoice_ref: &str, to: &AccountId, amount: u128, result: &str) {
        self.log.push(Attempt {
            invoice_ref: invoice_ref.to_string(),
            to: to.clone(),
            amount_micro_usdc: amount,
            result: result.to_string(),
            ts: rfc3339_now(),
        });
    }
}

fn emit_payment_event(
    invoice_ref: &str,
    to: &AccountId,
    amount: u128,
    result: &str,
    reason: Option<&str>,
) {
    let mut data = json!({
        "invoice_ref": invoice_ref,
        "to": to,
        "amount_micro_usdc": amount.to_string(),
        "result": result,
    });
    if let Some(reason) = reason {
        data["reason"] = json!(reason);
    }
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": "nep297",
            "version": "1.0.0",
            "event": "payment_attempt",
            "data": data,
        })
    ));
}

fn authorisation_id(to: &AccountId, amount: u128, invoice_ref: &str) -> String {
    let material = format!(
        "{}|{}|{}|{}|{}",
        env::current_account_id(),
        to,
        amount,
        invoice_ref,
        env::block_height()
    );
    let digest = env::sha256(material.as_bytes());
    let prefix: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("policy:{prefix}")
}

fn current_day() -> u32 {
    (now_ms() / 86_400_000) as u32
}

fn now_ms() -> u64 {
    env::block_timestamp() / 1_000_000
}

fn rfc3339_now() -> String {
    format_utc_ms(now_ms())
}

/// Minimal UTC formatter so the contract has no date-library dependency.
fn format_utc_ms(ms: u64) -> String {
    let seconds = ms / 1_000;
    let days = (seconds / 86_400) as i64;
    let rem = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days` algorithm (public domain).
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const DAY_NS: u64 = 86_400_000_000_000;
    const START_NS: u64 = 1_765_000_000_000_000_000;
    const CAP: u128 = 10_000_000;
    const THREE: u128 = 3_000_000;

    fn id(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn ctx(predecessor: &str, timestamp_ns: u64) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(id("policy.samimmi.testnet"))
            .predecessor_account_id(id(predecessor))
            .block_timestamp(timestamp_ns);
        builder
    }

    fn setup() -> PolicyContract {
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        let mut contract = PolicyContract::new(
            id("owner.samimmi.testnet"),
            id("agent.samimmi.testnet"),
            id("usdc.samimmi.testnet"),
            U128(CAP),
        );
        testing_env!(ctx("owner.samimmi.testnet", START_NS).build());
        contract.add_to_whitelist(id("alice.samimmi.testnet"));
        contract
    }

    #[test]
    fn formats_known_utc_instants() {
        assert_eq!(format_utc_ms(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc_ms(1_700_000_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(format_utc_ms(1_765_000_000_000), "2025-12-06T05:46:40Z");
    }

    #[test]
    fn agent_can_pay_a_whitelisted_amount_under_the_cap() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        let result = contract.try_pay(id("alice.samimmi.testnet"), U128(THREE), "INV-001".into());
        assert_eq!(result["ok"], true);
        assert_eq!(contract.get_policy()["spent_today_micro_usdc"], "3000000");
        assert_eq!(contract.get_policy()["paid_invoices"], 1);
    }

    #[test]
    fn duplicate_invoice_reference_is_refused() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        let first = contract.try_pay(id("alice.samimmi.testnet"), U128(1_000_000), "INV-DUP".into());
        assert_eq!(first["ok"], true);
        let second = contract.try_pay(id("alice.samimmi.testnet"), U128(1_000_000), "INV-DUP".into());
        assert_eq!(second["ok"], false);
        assert_eq!(second["reason"], "DUPLICATE_INVOICE");
        assert_eq!(contract.get_policy()["spent_today_micro_usdc"], "1000000");
    }

    #[test]
    fn zero_amount_and_invalid_reference_are_refused() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        let zero = contract.try_pay(id("alice.samimmi.testnet"), U128(0), "ZERO".into());
        assert_eq!(zero["reason"], "ZERO_AMOUNT");
        let long_ref = "x".repeat(65);
        let invalid = contract.try_pay(id("alice.samimmi.testnet"), U128(1), long_ref);
        assert_eq!(invalid["reason"], "INVALID_INVOICE_REF");
    }

    #[test]
    fn over_limit_is_refused_without_spending() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        let result = contract.try_pay(id("alice.samimmi.testnet"), U128(50_000_000), "INV-OVER".into());
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "OVER_LIMIT");
        assert_eq!(contract.get_policy()["spent_today_micro_usdc"], "0");
    }

    #[test]
    fn unknown_recipient_is_refused_before_the_cap() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        let result = contract.try_pay(id("eve.samimmi.testnet"), U128(50_000_000), "INV-EVE".into());
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "NOT_WHITELISTED");
    }

    #[test]
    fn owner_cannot_call_try_pay() {
        let mut contract = setup();
        testing_env!(ctx("owner.samimmi.testnet", START_NS).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.try_pay(id("alice.samimmi.testnet"), U128(1), "OWNER".into())
        }));
        assert!(result.is_err());
    }

    #[test]
    #[should_panic(expected = "only the policy owner")]
    fn agent_cannot_change_the_cap() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        contract.set_daily_cap(U128(CAP));
    }

    #[test]
    fn reset_clears_spent_idempotency_and_log() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        contract.try_pay(id("alice.samimmi.testnet"), U128(THREE), "INV-RESET".into());
        testing_env!(ctx("owner.samimmi.testnet", START_NS).build());
        contract.reset_spent();
        assert_eq!(contract.get_policy()["spent_today_micro_usdc"], "0");
        assert_eq!(contract.get_policy()["paid_invoices"], 0);
        assert_eq!(contract.get_log(Some(10)), json!([]));
    }

    #[test]
    fn daily_counter_rolls_over_at_utc_midnight() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        contract.try_pay(id("alice.samimmi.testnet"), U128(4_000_000), "INV-DAY".into());
        assert_eq!(contract.get_policy()["spent_today_micro_usdc"], "4000000");
        testing_env!(ctx("agent.samimmi.testnet", START_NS + DAY_NS).build());
        assert_eq!(contract.get_policy()["spent_today_micro_usdc"], "0");
    }

    #[test]
    fn log_is_newest_last_and_limited() {
        let mut contract = setup();
        testing_env!(ctx("agent.samimmi.testnet", START_NS).build());
        contract.try_pay(id("alice.samimmi.testnet"), U128(1_000_000), "INV-A".into());
        contract.try_pay(id("alice.samimmi.testnet"), U128(50_000_000), "INV-B".into());
        contract.try_pay(id("eve.samimmi.testnet"), U128(1_000_000), "INV-C".into());
        let log = contract.get_log(Some(2));
        let entries = log.as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["invoice_ref"], "INV-B");
        assert_eq!(entries[1]["invoice_ref"], "INV-C");
        assert!(entries[0]["ts"].as_str().unwrap().ends_with('Z'));
    }
}

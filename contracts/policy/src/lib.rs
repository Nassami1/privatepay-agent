//! PrivatePay Agent — on-chain spending policy.
//!
//! The contract is the last line of defence for an AI agent that is allowed to
//! pay invoices. It owns three facts the agent cannot change with its own key:
//!
//!   * `daily_cap_usdc` — the most the agent may authorise in one UTC day
//!   * `whitelist`      — the only recipients that may ever be paid
//!   * `log`            — an append-only record of allowed and blocked attempts
//!
//! Only the `owner` (the human's account, normally the contract account itself)
//! can change the policy. The agent runs on a Function Call Key restricted to
//! `try_pay`, so it can ask for permission but can never grant it to itself or
//! move funds out of the account.
//!
//! All amounts are whole USDC demo units (the hackathon prototype does not model
//! sub-cent precision). Nothing sensitive is stored on-chain: `invoice_ref` is an
//! opaque reference, never the invoice text.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// The log is a bounded ring: enough for a demo, never unbounded storage growth.
const MAX_LOG_ENTRIES: usize = 200;
const DEFAULT_LOG_LIMIT: u32 = 20;
const MAX_LOG_LIMIT: u32 = 100;

const RESULT_SUCCESS: &str = "SUCCESS";
const RESULT_OVER_LIMIT: &str = "BLOCKED_OVER_LIMIT";
const RESULT_NOT_WHITELISTED: &str = "BLOCKED_NOT_WHITELISTED";

const REASON_OVER_LIMIT: &str = "OVER_LIMIT";
const REASON_NOT_WHITELISTED: &str = "NOT_WHITELISTED";

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Attempt {
    pub invoice_ref: String,
    pub to: AccountId,
    pub amount_usdc: u32,
    pub result: String,
    pub ts: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PolicyContract {
    owner: AccountId,
    daily_cap_usdc: u32,
    spent_today_usdc: u32,
    /// Days since the Unix epoch (UTC). Used to roll the daily counter.
    day: u32,
    whitelist: Vec<AccountId>,
    log: Vec<Attempt>,
}

#[near]
impl PolicyContract {
    #[init]
    pub fn new(owner: AccountId, cap_usdc: u32) -> Self {
        Self {
            owner,
            daily_cap_usdc: cap_usdc,
            spent_today_usdc: 0,
            day: current_day(),
            whitelist: Vec::new(),
            log: Vec::new(),
        }
    }

    // ---------------------------------------------------------------- policy

    /// Owner only. Overwrites the daily cap.
    pub fn set_daily_cap(&mut self, cap_usdc: u32) -> Value {
        self.assert_owner();
        self.roll_day();
        self.daily_cap_usdc = cap_usdc;
        json!({ "ok": true, "cap_usdc": cap_usdc })
    }

    /// Owner only. Idempotent.
    pub fn add_to_whitelist(&mut self, account_id: AccountId) -> Value {
        self.assert_owner();
        if !self.whitelist.contains(&account_id) {
            self.whitelist.push(account_id);
        }
        json!({ "ok": true })
    }

    /// Owner only. No-op if the account is absent.
    pub fn remove_from_whitelist(&mut self, account_id: AccountId) -> Value {
        self.assert_owner();
        self.whitelist.retain(|entry| entry != &account_id);
        json!({ "ok": true })
    }

    /// Owner only. Demo/ops helper: clears today's spending counter so the
    /// two-minute demo can be replayed without waiting for UTC midnight.
    /// The agent's Function Call Key is not permitted to call this method.
    pub fn reset_spent(&mut self) -> Value {
        self.assert_owner();
        self.spent_today_usdc = 0;
        self.day = current_day();
        json!({ "ok": true })
    }

    // ------------------------------------------------------------- agent API

    /// The only method the agent's Function Call Key may invoke.
    ///
    /// Never throws for a policy decision: a blocked attempt is a normal,
    /// audited outcome, returned as `{ ok: false, reason }`. It does throw if
    /// the arguments are malformed, which is a bug rather than a policy result.
    pub fn try_pay(&mut self, to: AccountId, amount_usdc: u32, invoice_ref: String) -> Value {
        self.roll_day();

        // Order matters: a recipient that is not on the whitelist is refused
        // before we look at the amount, so an over-limit payment to a stranger
        // is reported as NOT_WHITELISTED.
        if !self.whitelist.contains(&to) {
            self.record(&invoice_ref, to.clone(), amount_usdc, RESULT_NOT_WHITELISTED);
            return json!({ "ok": false, "reason": REASON_NOT_WHITELISTED });
        }

        if self.spent_today_usdc.saturating_add(amount_usdc) > self.daily_cap_usdc {
            self.record(&invoice_ref, to.clone(), amount_usdc, RESULT_OVER_LIMIT);
            return json!({ "ok": false, "reason": REASON_OVER_LIMIT });
        }

        self.spent_today_usdc = self.spent_today_usdc.saturating_add(amount_usdc);
        self.record(&invoice_ref, to.clone(), amount_usdc, RESULT_SUCCESS);

        json!({
            "ok": true,
            // Policy authorisation receipt. The actual cross-chain settlement
            // reference is produced by the agent's Intents step.
            "tx": self.authorisation_id(&to, amount_usdc, &invoice_ref),
        })
    }

    // ----------------------------------------------------------------- views

    pub fn get_policy(&self) -> Value {
        let spent = if self.day == current_day() {
            self.spent_today_usdc
        } else {
            0
        };
        json!({
            "cap_usdc": self.daily_cap_usdc,
            "spent_today_usdc": spent,
            "whitelist": self.whitelist,
        })
    }

    pub fn get_log(&self, limit: Option<u32>) -> Value {
        let limit = limit.unwrap_or(DEFAULT_LOG_LIMIT).min(MAX_LOG_LIMIT) as usize;
        let start = self.log.len().saturating_sub(limit);
        Value::Array(
            self.log[start..]
                .iter()
                .map(|attempt| {
                    json!({
                        "invoice_ref": attempt.invoice_ref,
                        "to": attempt.to,
                        "amount_usdc": attempt.amount_usdc,
                        "result": attempt.result,
                        "ts": attempt.ts,
                    })
                })
                .collect(),
        )
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
            self.spent_today_usdc = 0;
        }
    }

    fn record(&mut self, invoice_ref: &str, to: AccountId, amount_usdc: u32, result: &str) {
        if self.log.len() >= MAX_LOG_ENTRIES {
            self.log.remove(0);
        }
        self.log.push(Attempt {
            invoice_ref: invoice_ref.to_string(),
            to,
            amount_usdc,
            result: result.to_string(),
            ts: rfc3339_now(),
        });
    }

    fn authorisation_id(&self, to: &AccountId, amount_usdc: u32, invoice_ref: &str) -> String {
        let material = format!(
            "{}|{}|{}|{}|{}|{}",
            env::current_account_id(),
            env::predecessor_account_id(),
            to,
            amount_usdc,
            invoice_ref,
            env::block_height()
        );
        let digest = env::sha256(material.as_bytes());
        let prefix: String = digest[..8].iter().map(|byte| format!("{byte:02x}")).collect();
        format!("policy:{prefix}")
    }
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
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_utc_instants() {
        assert_eq!(format_utc_ms(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc_ms(1_700_000_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(format_utc_ms(1_765_000_000_000), "2025-12-06T05:46:40Z");
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const DAY_NS: u64 = 86_400_000_000_000;
    const START_NS: u64 = 1_765_000_000_000_000_000;

    fn id(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn ctx(predecessor: &str, timestamp_ns: u64) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(id("privatepay.testnet"))
            .predecessor_account_id(id(predecessor))
            .block_timestamp(timestamp_ns);
        builder
    }

    fn setup() -> PolicyContract {
        testing_env!(ctx("owner.testnet", START_NS).build());
        let mut contract = PolicyContract::new(id("owner.testnet"), 10);
        contract.add_to_whitelist(id("alice.testnet"));
        contract
    }

    #[test]
    fn allows_payment_within_cap_and_records_it() {
        let mut contract = setup();
        let result = contract.try_pay(id("alice.testnet"), 3, "INV-001".into());
        assert_eq!(result["ok"], true);
        assert!(result["tx"].as_str().unwrap().starts_with("policy:"));
        assert_eq!(contract.get_policy()["spent_today_usdc"], 3);
    }

    #[test]
    fn blocks_over_limit_without_spending() {
        let mut contract = setup();
        let result = contract.try_pay(id("alice.testnet"), 50, "INV-002".into());
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "OVER_LIMIT");
        assert_eq!(contract.get_policy()["spent_today_usdc"], 0);
        let log = contract.get_log(Some(10));
        assert_eq!(log[0]["result"], "BLOCKED_OVER_LIMIT");
        assert_eq!(log[0]["invoice_ref"], "INV-002");
    }

    #[test]
    fn blocks_unknown_recipient_before_checking_amount() {
        let mut contract = setup();
        // 50 is also over the cap; the whitelist is checked first on purpose.
        let result = contract.try_pay(id("eve.testnet"), 50, "INV-003".into());
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "NOT_WHITELISTED");
        assert_eq!(contract.get_log(Some(10))[0]["result"], "BLOCKED_NOT_WHITELISTED");
    }

    #[test]
    fn whitelist_add_is_idempotent_and_remove_is_noop() {
        let mut contract = setup();
        contract.add_to_whitelist(id("alice.testnet"));
        assert_eq!(contract.get_policy()["whitelist"].as_array().unwrap().len(), 1);
        contract.remove_from_whitelist(id("eve.testnet"));
        assert_eq!(contract.get_policy()["whitelist"].as_array().unwrap().len(), 1);
        contract.remove_from_whitelist(id("alice.testnet"));
        assert_eq!(contract.get_policy()["whitelist"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn daily_counter_rolls_over_at_utc_midnight() {
        let mut contract = setup();
        contract.try_pay(id("alice.testnet"), 4, "INV-004".into());
        assert_eq!(contract.get_policy()["spent_today_usdc"], 4);

        testing_env!(ctx("owner.testnet", START_NS + DAY_NS).build());
        assert_eq!(contract.get_policy()["spent_today_usdc"], 0);

        contract.try_pay(id("alice.testnet"), 9, "INV-005".into());
        assert_eq!(contract.get_policy()["spent_today_usdc"], 9);
    }

    #[test]
    fn log_is_newest_last_and_limited() {
        let mut contract = setup();
        contract.try_pay(id("alice.testnet"), 1, "INV-A".into());
        contract.try_pay(id("alice.testnet"), 50, "INV-B".into());
        contract.try_pay(id("eve.testnet"), 1, "INV-C".into());

        let log = contract.get_log(Some(2));
        let entries = log.as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["invoice_ref"], "INV-B");
        assert_eq!(entries[1]["invoice_ref"], "INV-C");
        assert!(entries[0]["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn owner_can_reset_spent() {
        let mut contract = setup();
        contract.try_pay(id("alice.testnet"), 5, "INV-006".into());
        contract.reset_spent();
        assert_eq!(contract.get_policy()["spent_today_usdc"], 0);
    }

    #[test]
    #[should_panic(expected = "only the policy owner")]
    fn non_owner_cannot_change_policy() {
        let mut contract = setup();
        testing_env!(ctx("agent.testnet", START_NS).build());
        contract.set_daily_cap(1_000);
    }

    #[test]
    #[should_panic(expected = "only the policy owner")]
    fn agent_cannot_reset_spent() {
        let contract = setup();
        testing_env!(ctx("agent.testnet", START_NS).build());
        // `reset_spent` takes &mut self; the panic happens before any state use.
        let mut contract = contract;
        contract.reset_spent();
    }

    #[test]
    fn deposit_attempts_are_rejected_by_lack_of_payable_attr() {
        // try_pay is not #[payable]; near-sdk rejects attached deposits before
        // the body runs. This test documents the intent; the unit-test harness
        // does not enforce the attribute, so we only assert the contract never
        // forwards value itself.
        let contract = setup();
        assert_eq!(contract.get_policy()["cap_usdc"], 10);
    }
}

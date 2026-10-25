//! Minimal NEP-141 test token for PrivatePay Agent.
//!
//! Testnet only. This is a deliberately small token: balances live in a
//! `LookupMap`, there is no storage-registration flow, and only the owner can
//! mint. It exists so the policy contract can perform a real `ft_transfer`
//! against a real ledger instead of simulating settlement.
//!
//! Not audited. Not for mainnet.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

pub const DECIMALS: u8 = 6;

#[near(serializers = [json])]
pub struct FtMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestFt {
    owner: AccountId,
    total_supply: u128,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl TestFt {
    #[init]
    pub fn new(owner: AccountId, initial_supply: U128) -> Self {
        let mut balances = LookupMap::new(b"b");
        balances.insert(owner.clone(), initial_supply.0);
        Self {
            owner,
            total_supply: initial_supply.0,
            balances,
        }
    }

    /// Owner only. Test-token supply is minted on demand.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) -> U128 {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be greater than zero");
        self.total_supply = self.total_supply.saturating_add(amount.0);
        let balance = self.balance_of(&account_id).saturating_add(amount.0);
        self.balances.insert(account_id, balance);
        U128(balance)
    }

    /// NEP-141 transfer. The policy contract attaches exactly one yoctoNEAR.
    #[payable]
    pub fn ft_transfer(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> () {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        require!(amount.0 > 0, "amount must be greater than zero");

        let sender_id = env::predecessor_account_id();
        let sender_balance = self.balance_of(&sender_id);
        require!(
            sender_balance >= amount.0,
            "The account doesn't have enough balance"
        );

        self.balances
            .insert(sender_id.clone(), sender_balance - amount.0);
        let receiver_balance = self.balance_of(&receiver_id).saturating_add(amount.0);
        self.balances.insert(receiver_id.clone(), receiver_balance);

        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({
                "standard": "nep141",
                "version": "1.0.0",
                "event": "ft_transfer",
                "data": {
                    "old_owner_id": sender_id,
                    "new_owner_id": receiver_id,
                    "amount": amount.0.to_string(),
                    "memo": memo,
                }
            })
        ));
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance_of(&account_id))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_metadata(&self) -> FtMetadata {
        FtMetadata {
            spec: "ft-1.0.0".to_string(),
            name: "Test USD".to_string(),
            symbol: "tUSDC".to_string(),
            decimals: DECIMALS,
        }
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    fn balance_of(&self, account_id: &AccountId) -> u128 {
        self.balances.get(account_id).copied().unwrap_or(0)
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the token owner may mint"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const START_NS: u64 = 1_765_000_000_000_000_000;

    fn id(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit_yocto: u128) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(id("usdc.samimmi.testnet"))
            .predecessor_account_id(id(predecessor))
            .block_timestamp(START_NS)
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto));
        builder
    }

    fn setup() -> TestFt {
        testing_env!(ctx("owner.samimmi.testnet", 0).build());
        let mut token = TestFt::new(id("owner.samimmi.testnet"), U128(0));
        token.mint(id("owner.samimmi.testnet"), U128(1_000_000));
        token
    }

    #[test]
    fn owner_can_mint_and_balances_update() {
        let token = setup();
        assert_eq!(token.ft_balance_of(id("owner.samimmi.testnet")).0, 1_000_000);
        assert_eq!(token.ft_total_supply().0, 1_000_000);
        assert_eq!(token.ft_metadata().decimals, 6);
    }

    #[test]
    #[should_panic(expected = "only the token owner may mint")]
    fn non_owner_cannot_mint() {
        let mut token = setup();
        testing_env!(ctx("alice.samimmi.testnet", 0).build());
        token.mint(id("alice.samimmi.testnet"), U128(1));
    }

    #[test]
    fn transfer_moves_balances_with_one_yocto() {
        let mut token = setup();
        testing_env!(ctx("owner.samimmi.testnet", 1).build());
        token.ft_transfer(
            id("alice.samimmi.testnet"),
            U128(400_000),
            Some("INV-1".to_string()),
        );
        assert_eq!(token.ft_balance_of(id("owner.samimmi.testnet")).0, 600_000);
        assert_eq!(token.ft_balance_of(id("alice.samimmi.testnet")).0, 400_000);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit")]
    fn transfer_requires_exactly_one_yocto() {
        let mut token = setup();
        testing_env!(ctx("owner.samimmi.testnet", 0).build());
        token.ft_transfer(id("alice.samimmi.testnet"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "amount must be greater than zero")]
    fn transfer_rejects_zero() {
        let mut token = setup();
        testing_env!(ctx("owner.samimmi.testnet", 1).build());
        token.ft_transfer(id("alice.samimmi.testnet"), U128(0), None);
    }
}

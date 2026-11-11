use crate::ephemeral::EphemeralArray;
use crate::keys::getters::get_public_keys;
use crate::messages::delivery::MessageDelivery;
use crate::note::{lifecycle::create_note, note_getter::get_note};
use crate::oracle::block_header::get_block_header_at;
use crate::oracle::notes::get_sender_for_tags;
use crate::oracle::nullifiers::{check_nullifier_exists, get_nullifier_statuses};
use crate::protocol::{
    abis::{function_selector::FunctionSelector, gas::Gas, gas_fees::GasFees, gas_settings::GasSettings},
    address::AztecAddress,
    constants::{MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT, MAX_PROCESSABLE_L2_GAS},
    traits::{FromField, Hash},
};
use crate::test::{helpers::test_environment::{PrivateContextOptions, TestEnvironment}, mocks::mock_note::MockNote};

global STORAGE_SLOT: Field = 13;

#[test]
unconstrained fn at_sets_contract_address() {
    let env = TestEnvironment::new();
    let contract_address = AztecAddress::from_field(17);

    env.private_context_at(contract_address, |context| { assert_eq(context.this_address(), contract_address); });
}

#[test]
unconstrained fn opts_sets_contract_address_and_anchor_block_number() {
    let env = TestEnvironment::new();

    env.mine_block();
    let anchor_block_number = env.last_block_number() - 1;

    let contract_address = AztecAddress::from_field(17);

    env.private_context_opts(PrivateContextOptions::new().at_contract_address(contract_address), |context| {
        assert_eq(context.this_address(), contract_address);
    });

    env.private_context_opts(PrivateContextOptions::new().at_anchor_block_number(anchor_block_number), |context| {
        assert_eq(context.get_anchor_block_header().block_number(), anchor_block_number);
    });

    env.private_context_opts(
        PrivateContextOptions::new().at_contract_address(contract_address).at_anchor_block_number(anchor_block_number),
        |context| {
            assert_eq(context.this_address(), contract_address);
            assert_eq(context.get_anchor_block_header().block_number(), anchor_block_number);
        },
    );
}

#[test]
unconstrained fn msg_sender_defaults_to_the_zero_address() {
    let env = TestEnvironment::new();

    env.private_context(|context| { assert_eq(context.maybe_msg_sender(), Option::some(AztecAddress::zero())); });
}

#[test]
unconstrained fn sender_for_tags_is_unset_by_default() {
    let env = TestEnvironment::new();

    env.private_context(|_| { assert(get_sender_for_tags().is_none()); });
}

#[test]
unconstrained fn with_from_accepts_an_address_that_is_not_an_account() {
    let env = TestEnvironment::new();
    let from = AztecAddress::from_field(17);

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        assert_eq(context.maybe_msg_sender(), Option::some(from));
    });
}

#[test]
unconstrained fn with_from_sets_msg_sender() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        assert_eq(context.maybe_msg_sender(), Option::some(from));
    });
}

#[test]
unconstrained fn with_from_sets_sender_for_tags() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |_| {
        assert_eq(get_sender_for_tags(), Option::some(from));
    });
}

#[test]
unconstrained fn with_from_delivers_messages_to_a_recipient_in_scope() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();
    let recipient = env.create_light_account();

    env.private_context_opts(
        PrivateContextOptions::new().with_from(from).with_additional_scopes([recipient]),
        |context| {
            create_note(
                context,
                recipient,
                STORAGE_SLOT,
                MockNote::new(7).build_note(),
            )
                .deliver(MessageDelivery::onchain_unconstrained());
        },
    );
}

#[test]
unconstrained fn with_from_delivers_messages_to_from() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        create_note(context, from, STORAGE_SLOT, MockNote::new(7).build_note()).deliver(
            MessageDelivery::onchain_unconstrained(),
        );
    });
}

#[test(should_fail_with = "Sender for tags is not set")]
unconstrained fn does_not_deliver_messages_of_the_context_by_default() {
    let mut env = TestEnvironment::new();
    let recipient = env.create_light_account();

    env.private_context(|context| {
        create_note(
            context,
            recipient,
            STORAGE_SLOT,
            MockNote::new(7).build_note(),
        )
            .deliver(MessageDelivery::onchain_unconstrained());
    });
}

#[test]
unconstrained fn with_from_accesses_keys_of_from() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        let _ = context.request_nhk_app(get_public_keys(from).npk_m_hash);
    });
}

#[test(should_fail_with = "Key validation request denied")]
unconstrained fn with_from_does_not_access_keys_of_other_accounts() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();
    let other = env.create_light_account();

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        let _ = context.request_nhk_app(get_public_keys(other).npk_m_hash);
    });
}

#[test]
unconstrained fn with_from_accesses_notes_of_from() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();
    let note = MockNote::new(7).build_note();

    let note_message = env.private_context(|context| create_note(context, from, STORAGE_SLOT, note));
    env.discover_note(note_message);

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        assert_eq(get_note::<MockNote>(context, Option::some(from), STORAGE_SLOT).note, note);
    });
}

#[test(should_fail_with = "Failed to get a note")]
unconstrained fn with_from_does_not_access_notes_of_other_accounts() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();
    let other = env.create_light_account();

    let note_message =
        env.private_context(|context| create_note(context, other, STORAGE_SLOT, MockNote::new(7).build_note()));
    env.discover_note(note_message);

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        let _ = get_note::<MockNote>(context, Option::some(other), STORAGE_SLOT);
    });
}

#[test(should_fail_with = "Failed to get a note")]
unconstrained fn does_not_access_notes_of_an_address_that_is_not_an_account_by_default() {
    let env = TestEnvironment::new();
    let owner = AztecAddress::from_field(17);

    let note_message =
        env.private_context(|context| create_note(context, owner, STORAGE_SLOT, MockNote::new(7).build_note()));
    env.discover_note(note_message);

    env.private_context(|context| { let _ = get_note::<MockNote>(context, Option::some(owner), STORAGE_SLOT); });
}

#[test]
unconstrained fn with_additional_scopes_accesses_notes_of_an_address_that_is_not_an_account() {
    let env = TestEnvironment::new();
    let owner = AztecAddress::from_field(17);
    let note = MockNote::new(7).build_note();

    let note_message = env.private_context(|context| create_note(context, owner, STORAGE_SLOT, note));
    env.discover_note(note_message);

    env.private_context_opts(PrivateContextOptions::new().with_additional_scopes([owner]), |context| {
        assert_eq(get_note::<MockNote>(context, Option::some(owner), STORAGE_SLOT).note, note);
    });
}

#[test]
unconstrained fn with_additional_scopes_keeps_all_accounts_in_scope_by_default() {
    let mut env = TestEnvironment::new();
    let account = env.create_light_account();
    let note = MockNote::new(7).build_note();

    let note_message = env.private_context(|context| create_note(context, account, STORAGE_SLOT, note));
    env.discover_note(note_message);

    env.private_context_opts(
        PrivateContextOptions::new().with_additional_scopes([AztecAddress::from_field(17)]),
        |context| { assert_eq(get_note::<MockNote>(context, Option::some(account), STORAGE_SLOT).note, note); },
    );
}

#[test]
unconstrained fn with_from_accesses_notes_of_a_from_that_is_not_an_account() {
    let env = TestEnvironment::new();
    let from = AztecAddress::from_field(17);
    let note = MockNote::new(7).build_note();

    let note_message = env.private_context(|context| create_note(context, from, STORAGE_SLOT, note));
    env.discover_note(note_message);

    env.private_context_opts(PrivateContextOptions::new().with_from(from), |context| {
        assert_eq(get_note::<MockNote>(context, Option::some(from), STORAGE_SLOT).note, note);
    });
}

#[test]
unconstrained fn options_can_be_set_in_any_order() {
    let env = TestEnvironment::new();
    let from = AztecAddress::from_field(17);

    env.private_context_opts(PrivateContextOptions::new().with_additional_scopes([]).with_from(from), |context| {
        assert_eq(context.maybe_msg_sender(), Option::some(from));
    });
}

#[test]
unconstrained fn with_additional_scopes_accesses_notes_of_other_accounts() {
    let mut env = TestEnvironment::new();
    let from = env.create_light_account();
    let other = env.create_light_account();
    let note = MockNote::new(7).build_note();

    let note_message = env.private_context(|context| create_note(context, other, STORAGE_SLOT, note));
    env.discover_note(note_message);

    env.private_context_opts(PrivateContextOptions::new().with_from(from).with_additional_scopes([other]), |context| {
        assert_eq(get_note::<MockNote>(context, Option::some(other), STORAGE_SLOT).note, note);
    });
}

#[test]
unconstrained fn default_gas_settings_match_protocol_max() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        let gas_settings = context.gas_settings();
        assert_eq(
            gas_settings.gas_limits,
            Gas::new(
                MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT,
                MAX_PROCESSABLE_L2_GAS,
            ),
        );
        assert_eq(
            gas_settings.teardown_gas_limits,
            Gas::new(
                MAX_PROCESSABLE_DA_GAS_PER_CHECKPOINT / 8,
                MAX_PROCESSABLE_L2_GAS / 8,
            ),
        );
        assert_eq(gas_settings.max_fees_per_gas, GasFees::new(0, 0));
        assert_eq(gas_settings.max_priority_fees_per_gas, GasFees::new(0, 0));
    });
}

#[test]
unconstrained fn opts_sets_individual_gas_fields() {
    let env = TestEnvironment::new();

    let gas_limits = Gas::new(123_456, 789_012);
    let teardown_gas_limits = Gas::new(1_111, 2_222);
    let max_fees_per_gas = GasFees::new(7, 11);
    let max_priority_fees_per_gas = GasFees::new(3, 5);

    env.private_context_opts(PrivateContextOptions::new().with_gas_limits(gas_limits), |context| {
        assert_eq(context.gas_settings().gas_limits, gas_limits);
    });

    env.private_context_opts(PrivateContextOptions::new().with_teardown_gas_limits(teardown_gas_limits), |context| {
        assert_eq(context.gas_settings().teardown_gas_limits, teardown_gas_limits);
    });

    env.private_context_opts(PrivateContextOptions::new().with_max_fees_per_gas(max_fees_per_gas), |context| {
        assert_eq(context.gas_settings().max_fees_per_gas, max_fees_per_gas);
    });

    env.private_context_opts(
        PrivateContextOptions::new().with_max_priority_fees_per_gas(max_priority_fees_per_gas),
        |context| { assert_eq(context.gas_settings().max_priority_fees_per_gas, max_priority_fees_per_gas); },
    );
}

#[test]
unconstrained fn opts_with_gas_settings_sets_all_fields() {
    let env = TestEnvironment::new();

    let gas_settings = GasSettings::new(
        Gas::new(123_456, 789_012),
        Gas::new(1_111, 2_222),
        GasFees::new(7, 11),
        GasFees::new(3, 5),
    );

    env.private_context_opts(PrivateContextOptions::new().with_gas_settings(gas_settings), |context| {
        assert_eq(context.gas_settings(), gas_settings);
    });
}

#[test]
unconstrained fn uses_last_block_number() {
    let env = TestEnvironment::new();

    let last_block_number = env.last_block_number();

    env.private_context(|context| { assert_eq(last_block_number, context.get_anchor_block_header().block_number()); });
}

#[test]
unconstrained fn advances_block_number() {
    let env = TestEnvironment::new();

    let first_block_number = env.private_context(|context| context.get_anchor_block_header().block_number());
    let second_block_number = env.private_context(|context| context.get_anchor_block_header().block_number());

    assert_eq(second_block_number, first_block_number + 1);
}

#[test]
unconstrained fn does_not_advance_the_timestamp() {
    let env = TestEnvironment::new();

    env.private_context(|_| {});
    let first_timestamp = env.last_block_timestamp();
    env.private_context(|_| {});
    let second_timestamp = env.last_block_timestamp();

    assert_eq(second_timestamp, first_timestamp);
}

#[test(should_fail_with = "Duplicate siloed nullifier")]
unconstrained fn rejects_duplicate_transient_nullifiers() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        context.push_nullifier_unsafe(1);
        context.push_nullifier_unsafe(1);
    });
}

#[test(should_fail_with = "already present")]
unconstrained fn rejects_duplicate_settled_nullifiers() {
    let env = TestEnvironment::new();

    env.private_context(|context| { context.push_nullifier_unsafe(1); });

    env.private_context(|context| { context.push_nullifier_unsafe(1); });
}

#[test]
unconstrained fn repeats_contract_address() {
    let env = TestEnvironment::new();

    let first_address = env.private_context(|context| context.this_address());
    let second_address = env.private_context(|context| context.this_address());

    assert_eq(first_address, second_address);
}

#[test(should_fail_with = "Contract calls are forbidden")]
unconstrained fn private_call_fails() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        let _ = context.call_private_function_no_args(AztecAddress::zero(), FunctionSelector::zero());
    });
}

#[test(should_fail_with = "Enqueueing public calls is not supported")]
unconstrained fn public_call_fails() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        let _ = context.call_public_function_no_args(AztecAddress::zero(), FunctionSelector::zero(), false);
    });
}

#[test(should_fail_with = "Enqueueing public calls is not supported")]
unconstrained fn set_teardown_fails() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        let _ = context.set_public_teardown_function(AztecAddress::zero(), FunctionSelector::zero(), [], false);
    });
}

#[test]
unconstrained fn check_nullifier_exists_nonexistent() {
    let env = TestEnvironment::new();

    env.private_context(|_| { assert(!check_nullifier_exists(1)); });
}

#[test]
unconstrained fn check_nullifier_exists_settled() {
    let env = TestEnvironment::new();

    env.private_context(|context| { context.push_nullifier_unsafe(1); });

    env.private_context(|_| { assert(check_nullifier_exists(1)); });
}

#[test]
unconstrained fn check_nullifier_exists_pending() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        context.push_nullifier_unsafe(1);
        assert(check_nullifier_exists(1));
    });
}

#[test]
unconstrained fn get_nullifier_statuses_nonexistent() {
    let env = TestEnvironment::new();

    env.private_context(|_| {
        let status = get_nullifier_statuses(EphemeralArray::from_array([1])).get(0);
        assert(!status.exists);
        assert(status.origin_block.is_none());
    });
}

#[test]
unconstrained fn get_nullifier_statuses_settled() {
    let env = TestEnvironment::new();

    env.private_context(|context| { context.push_nullifier_unsafe(1); });
    let settled_block_number = env.last_block_number();

    env.private_context(|context| {
        let status = get_nullifier_statuses(EphemeralArray::from_array([1])).get(0);
        assert(status.exists);

        let origin_block = status.origin_block.unwrap();
        assert_eq(origin_block.block_number, settled_block_number);
        assert_eq(origin_block.block_hash, get_block_header_at(settled_block_number, *context).hash());
    });
}

#[test]
unconstrained fn get_nullifier_statuses_pending() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        context.push_nullifier_unsafe(1);

        let status = get_nullifier_statuses(EphemeralArray::from_array([1])).get(0);
        assert(status.exists);
        assert(status.origin_block.is_none());
    });
}

#[test]
unconstrained fn get_nullifier_statuses_mixed() {
    let env = TestEnvironment::new();

    env.private_context(|context| { context.push_nullifier_unsafe(1); });

    env.private_context(|context| {
        context.push_nullifier_unsafe(2);

        let statuses = get_nullifier_statuses(EphemeralArray::from_array([1, 2, 3]));
        assert_eq(statuses.len(), 3);

        let settled = statuses.get(0);
        assert(settled.exists);
        assert(settled.origin_block.is_some());

        let pending = statuses.get(1);
        assert(pending.exists);
        assert(pending.origin_block.is_none());

        let nonexistent = statuses.get(2);
        assert(!nonexistent.exists);
        assert(nonexistent.origin_block.is_none());
    });
}

use aztec::test::helpers::test_environment::TestEnvironment;

// Deploys a contract of the workspace that this crate does not depend on.
#[test]
unconstrained fn deploys_a_contract_it_does_not_depend_on() {
    let mut env = TestEnvironment::new();
    let _ = env.deploy("@unrelated_contract/Unrelated").without_initializer();
}

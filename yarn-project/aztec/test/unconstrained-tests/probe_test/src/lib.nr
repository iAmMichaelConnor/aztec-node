use aztec::test::helpers::test_environment::TestEnvironment;
use probe_contract::Probe;

#[test]
unconstrained fn private_functions_run_unconstrained() {
    let mut env = TestEnvironment::new();
    let caller = env.create_light_account();
    let probe = env.deploy("@probe_contract/Probe").without_initializer();

    assert(env.call_private(caller, Probe::at(probe).runs_unconstrained()));
}

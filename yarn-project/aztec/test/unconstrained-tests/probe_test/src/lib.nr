use aztec::test::helpers::test_environment::TestEnvironment;
use probe_contract::Probe;

unconstrained fn runs_unconstrained() -> bool {
    let mut env = TestEnvironment::new();
    let caller = env.create_light_account();
    let probe = env.deploy("@probe_contract/Probe").without_initializer();

    env.call_private(caller, Probe::at(probe).runs_unconstrained())
}

// Passes only against a regular build of the contract.
#[test]
unconstrained fn private_functions_run_constrained() {
    assert(!runs_unconstrained());
}

// Passes only against an unconstrained build of the contract.
#[test]
unconstrained fn private_functions_run_unconstrained() {
    assert(runs_unconstrained());
}

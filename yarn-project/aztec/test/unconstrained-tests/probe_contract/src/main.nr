use aztec::macros::aztec;

#[aztec]
pub contract Probe {
    use aztec::macros::functions::external;
    use std::runtime::is_unconstrained;

    // Reports how the function was compiled, which is all that tells the two builds of this contract apart in a test.
    #[external("private")]
    fn runs_unconstrained() -> bool {
        is_unconstrained()
    }
}

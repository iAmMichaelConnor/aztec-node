use aztec::macros::aztec;

// A contract that no test crate depends on.
#[aztec]
pub contract Unrelated {
    use aztec::macros::functions::external;

    #[external("private")]
    fn private_function() -> Field {
        0
    }
}

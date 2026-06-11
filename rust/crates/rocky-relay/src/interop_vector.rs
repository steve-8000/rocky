// GENERATED known-answer vector — produced by tweetnacl + base64-js.
//
// Source harness: `~/.relay_interop_scratch/relay_interop.mjs gen`, which imports
// `tweetnacl` + `base64-js` resolved from `/Users/steve/roy/rocky/core/node_modules`.
// The bundle is `[nonce(24)] ++ nacl.box.after(plaintext, nonce,
// nacl.box.before(bobPub, aliceSecret))`. This proves Rust `decrypt` matches
// tweetnacl byte-for-byte. Do NOT hand-edit; regenerate from the harness.
const TWEETNACL_VECTOR: TweetNaclVector = TweetNaclVector {
    alice_secret_b64: "DiY48i/HA8C8x/KMXJFF8zYrQs/7lXIeXsDGu3H2vFM=",
    bob_public_b64: "qz8iNkMTN8tcJ2NdjibyMAYmilYTknahZcusv1vU6hg=",
    bundle_b64: "CjaVcf/m6Iro1PKb4G59TcQBqxk2rzCrD+NdPeEhO2OoGyKAZgFoiMZfV7Q2TNBXRGAS0fgBT+7b8HTh9XUAKYRGSI/D",
    nonce: &[
        10, 54, 149, 113, 255, 230, 232, 138, 232, 212, 242, 155, 224, 110, 125, 77, 196, 1, 171,
        25, 54, 175, 48, 171,
    ],
    plaintext: "interop: tweetnacl -> rust OK",
};

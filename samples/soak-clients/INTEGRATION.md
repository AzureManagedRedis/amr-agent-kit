# Integration Notes

The retained integration base is
`ec7e4502571fcd3e529c11b8cf3046e930c4737e`. It already contains the pinned
skill-format review commit
`9aa6250aa40d1a5a7dda11a9100ae331e4ad5661`; no reset, rebase, or history
rewrite is required.

The soak-client corpus was added on top of that base by
`6e8b697054c275ec8dfb3774c15d5085c165acc6` and hardened for run-scoped
cleanup by `6e2909cdb115e128890f8680e0b57f787c646f43`. This note is retained so
an integrator can verify the base relationship before replaying or merging the
corpus commits.

-- Install-only Beijing nprod USD -> CNY label repair authority.
--
-- This migration never changes account data during `prisma migrate deploy`.
-- It adds one database-bound, immutable 71-account manifest to the audit and
-- terminal-proof contract installed by 20260813000100/00101. The owner-only
-- apply function below is the sole write boundary.

CREATE OR REPLACE FUNCTION "billing_account_currency_label_manifest_nprod_v2"()
RETURNS TABLE(
  ordinal INTEGER,
  billing_account_id TEXT,
  account_type TEXT,
  account_status TEXT,
  account_created_at TIMESTAMP(3),
  account_deleted_at TIMESTAMP(3),
  ledger_status TEXT,
  ledger_version INTEGER,
  ledger_hash TEXT,
  classification TEXT
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    (1, '40703476-f6de-4528-8119-11d494bfe2f4', 'enterprise', 'active', TIMESTAMP '2026-07-06 14:13:31.402', NULL, 'RECONCILED_V2', 2, '684a58b7c0947a684f2344f80a02232514c1b8c5dbdfded6a44ca0d39cd820ed', 'ACTIVE_CREDIT_CONFIG'),
    (2, '526706f2-923f-4fdc-9ae8-bbee3fc74599', 'enterprise', 'active', TIMESTAMP '2026-07-06 13:50:32.189', NULL, 'RECONCILED_V2', 2, '2964cb70301dac9b7950b14ce7796d595895d9b94a821a5ca2dbf9ba80eeb5b2', 'ACTIVE_STANDARD'),
    (3, '7aa6e486-f8f7-4008-8ec5-87088ac86106', 'enterprise', 'deleted', TIMESTAMP '2026-07-06 09:05:09.494', TIMESTAMP '2026-07-06 09:30:24.796', 'RECONCILED_V2', 2, '9116cdc1c6026e697a5efe0a268b0927a6d7b1e11b49654935c880dc1891ac84', 'DELETED_INERT_MEMBER_METADATA'),
    (4, '9f60325a-9c7c-4aa8-a9e7-ba40782abf54', 'enterprise', 'deleted', TIMESTAMP '2026-07-06 09:48:26.316', TIMESTAMP '2026-07-06 09:49:39.851', 'RECONCILED_V2', 2, '0afeecbece6af442e980bb825132458f5251b44ec678549701b561e034d42471', 'DELETED_INERT_MEMBER_METADATA'),
    (5, 'ba_personal_01352d9f-864c-49a5-a406-5ba4b7d6516e', 'personal', 'active', TIMESTAMP '2026-07-10 07:21:51.087', NULL, 'RECONCILED_V2', 2, '33dee89897f0e2d8d96e0edde6e460f7b0cc4c95311ce4551b179f352ced470a', 'ACTIVE_STANDARD'),
    (6, 'ba_personal_0173d73e-a8ef-4b19-b1e7-3525f81ae2f8', 'personal', 'active', TIMESTAMP '2026-06-24 05:40:41.732', NULL, 'RECONCILED_V2', 2, 'eaee8dce1590b5b4dc51394fc62a361e088808bdf498ffa30836afaab8552dec', 'ACTIVE_STANDARD'),
    (7, 'ba_personal_1', 'personal', 'active', TIMESTAMP '2026-06-28 14:32:07.034', NULL, 'RECONCILED_V2', 2, 'ddcf83f126e7543196df42d7e5f40f708200d73db3dc4475d1ace4ed8b32b656', 'ACTIVE_STANDARD'),
    (8, 'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b', 'personal', 'active', TIMESTAMP '2026-06-15 07:15:53.039', NULL, 'RECONCILED_V2', 2, '64273edccb905f433a927a892585bbbad71ca440fd32a5fd7e89e4ef9c550487', 'ACTIVE_NEGATIVE_WALLET_RECONCILED'),
    (9, 'ba_personal_174', 'personal', 'active', TIMESTAMP '2026-07-10 08:06:33.239', NULL, 'RECONCILED_V2', 2, '1ae77e6fa6b9022a8ba620097d1d58cd63a451bdacb698160392da5afdeda6f9', 'ACTIVE_STANDARD'),
    (10, 'ba_personal_176', 'personal', 'active', TIMESTAMP '2026-07-10 09:48:49.881', NULL, 'RECONCILED_V2', 2, '9ad237c6c415ed978278bcf7d57c4c2f774f0bf9fc3bdec78861df23478a1545', 'ACTIVE_STANDARD'),
    (11, 'ba_personal_178', 'personal', 'active', TIMESTAMP '2026-07-10 12:45:22.627', NULL, 'RECONCILED_V2', 2, '87d41dad48bd17ddba0e1b07b5417b3495e9c643ebd017c9b779e2a51552e407', 'ACTIVE_STANDARD'),
    (12, 'ba_personal_17fe51aa-0d1f-443a-a66b-2b8809e80fc1', 'personal', 'active', TIMESTAMP '2026-06-18 04:54:55.821', NULL, 'RECONCILED_V2', 2, '5b67ea097b8d87b524518ce787dca9f14a400c7aa8624317b9704b58bc056b71', 'ACTIVE_STANDARD'),
    (13, 'ba_personal_180', 'personal', 'active', TIMESTAMP '2026-06-30 06:28:37.884', NULL, 'RECONCILED_V2', 2, '5bbdc116a7f88cdfec42ead9843ef0bddf8f0deb3fe6f50fb8c4666be0e9e6a8', 'ACTIVE_STANDARD'),
    (14, 'ba_personal_1f1c996c-e89f-419c-81d1-1c9c54c6408e', 'personal', 'active', TIMESTAMP '2026-06-15 12:21:04.131', NULL, 'RECONCILED_V2', 2, '4855b0f99a6742c0adc4ac699f9ad171a71889739165bd2f9210bdab8b56c058', 'ACTIVE_STANDARD'),
    (15, 'ba_personal_31955542-44f4-4d32-8b4f-bb0db4333fcd', 'personal', 'active', TIMESTAMP '2026-06-15 07:14:59.337', NULL, 'RECONCILED_V2', 2, '273e94dba39a97ff7239b905a29603587deac27f3ce0069f68931726e1a95fac', 'ACTIVE_STANDARD'),
    (16, 'ba_personal_40a17aa0-d257-4612-a1fb-3b8f157fb486', 'personal', 'active', TIMESTAMP '2026-06-16 06:22:00.285', NULL, 'RECONCILED_V2', 2, '11a1fde8731889e93fa8035fea45fb762942c8821699d58c415eb602fd2ce653', 'ACTIVE_STANDARD'),
    (17, 'ba_personal_46121dc9-bae6-41d2-a297-403d58e59b22', 'personal', 'active', TIMESTAMP '2026-06-22 07:32:27.699', NULL, 'RECONCILED_V2', 2, '7d804fa353b7090dcf58e001282583393c63ada7a18d3f5ac8976bd5443e1097', 'ACTIVE_STANDARD'),
    (18, 'ba_personal_4afcc651-989d-47ea-acc2-5ba18963bfda', 'personal', 'active', TIMESTAMP '2026-06-15 08:52:20.802', NULL, 'RECONCILED_V2', 2, 'e58924d3c8c480760b51cefe61a438c03e0e726187bda4b41700a9ce15b03d89', 'ACTIVE_STANDARD'),
    (19, 'ba_personal_5041afce-a3f1-48b9-8cef-9d1b47707802', 'personal', 'active', TIMESTAMP '2026-06-15 10:54:36.260', NULL, 'RECONCILED_V2', 2, '9e79add33eaade17135a7ca6fcfc1568ea309d917d5e312bab2a86c550c428b4', 'ACTIVE_STANDARD'),
    (20, 'ba_personal_5d552dfa-afe3-42e5-bb5f-cda7d73ab6af', 'personal', 'active', TIMESTAMP '2026-06-29 02:55:49.328', NULL, 'RECONCILED_V2', 2, '53791207824933380f4b5b02535c9b458886a8c12190976e3beb58422d6992d3', 'ACTIVE_STANDARD'),
    (21, 'ba_personal_62f5f1f0-e088-4002-85bc-bd1522867e39', 'personal', 'active', TIMESTAMP '2026-06-16 06:40:55.210', NULL, 'RECONCILED_V2', 2, 'b434d7932392fc650470fbab85d6d5c9ee7fd0c53364bd37392752cdd8cffe6c', 'ACTIVE_STANDARD'),
    (22, 'ba_personal_652a3519-1fa8-40ec-9a3c-0d6417f60b73', 'personal', 'active', TIMESTAMP '2026-06-15 08:50:05.500', NULL, 'RECONCILED_V2', 2, '07726175c27b2ee4a966c3637a1386840dce739d99fbe2821be68a4333bef6c0', 'ACTIVE_STANDARD'),
    (23, 'ba_personal_72636c24-c826-4bf7-8c90-23094ed1d93e', 'personal', 'active', TIMESTAMP '2026-07-07 08:40:38.329', NULL, 'RECONCILED_V2', 2, 'f69c34fc717f39721d0a497c1022ca6837c44158b862c2eaf9872c5033f58c19', 'ACTIVE_STANDARD'),
    (24, 'ba_personal_7edaef29-ec56-4f5b-b5fe-ea658985e61e', 'personal', 'active', TIMESTAMP '2026-06-15 11:31:39.819', NULL, 'RECONCILED_V2', 2, '10c105a870a089b55648027bafe8b1e939cd1d840b92a845fa14635432e65933', 'ACTIVE_STANDARD'),
    (25, 'ba_personal_81eb140d-d06b-4282-8bb2-d9bbe5663c35', 'personal', 'active', TIMESTAMP '2026-07-07 09:41:31.440', NULL, 'RECONCILED_V2', 2, '4f9081a58d272d42c3e7e0c3cb9db370a98d6ffe2652727daf5c10f77b92178f', 'ACTIVE_STANDARD'),
    (26, 'ba_personal_85736691-78f6-4754-9971-c578427d4aa3', 'personal', 'active', TIMESTAMP '2026-06-18 06:24:48.464', NULL, 'RECONCILED_V2', 2, '2ccdf5dae77168cdde85f962528d72f15dfb9c211551f46b7027d2736ba61111', 'ACTIVE_STANDARD'),
    (27, 'ba_personal_913d544f-3280-403e-8f61-ad85ec6e7147', 'personal', 'active', TIMESTAMP '2026-07-10 07:50:01.938', NULL, 'RECONCILED_V2', 2, '21e0098f958f05c4dacb42777c625202f06f5800fa8aa1fc3b264f2255bf5d5a', 'ACTIVE_STANDARD'),
    (28, 'ba_personal_986c4c59-a8f3-42e4-a963-797ca4659874', 'personal', 'active', TIMESTAMP '2026-06-20 13:01:53.498', NULL, 'RECONCILED_V2', 2, '7e64c9f5e4f8eac691de9eb98d81100150f5067f293af490c9d85d026c885046', 'ACTIVE_STANDARD'),
    (29, 'ba_personal_9948fb82-7144-48bd-aa4f-4dc0cfa4a42a', 'personal', 'active', TIMESTAMP '2026-07-01 07:23:50.896', NULL, 'RECONCILED_V2', 2, '7057dbc1523891aa165770f1806a204c71624a5431ca2052f53c444ace7d1c23', 'ACTIVE_STANDARD'),
    (30, 'ba_personal_99556fb4-ef9f-4a65-8eb0-ddfac6b9b66c', 'personal', 'active', TIMESTAMP '2026-06-17 07:01:33.162', NULL, 'RECONCILED_V2', 2, '619509dc2dce8332439bb32ca80c7a26f2b9e01f1e2076b79a8d339625cc02f5', 'ACTIVE_STANDARD'),
    (31, 'ba_personal_a605b436-dd79-4f9e-9403-fe706eacb413', 'personal', 'active', TIMESTAMP '2026-06-16 05:33:45.846', NULL, 'RECONCILED_V2', 2, 'f63d35c808a890c452df546007b45e75723d85e24f0ed1d47365b90cb2797e3d', 'ACTIVE_STANDARD'),
    (32, 'ba_personal_aa584178-04d8-487e-889f-9a9022441ecb', 'personal', 'active', TIMESTAMP '2026-07-10 07:45:27.279', NULL, 'RECONCILED_V2', 2, '61014dbf3506367b321b25a2631362752476f73592086fb9df1c8eaaba55a944', 'ACTIVE_STANDARD'),
    (33, 'ba_personal_b86221cf-d2d8-4b10-83b2-37d970ec28a9', 'personal', 'active', TIMESTAMP '2026-06-17 09:48:04.956', NULL, 'RECONCILED_V2', 2, '5288cac7c8664b00f1e72980f2ac653475bc167dfa697e12fe29bab64c5b24cc', 'ACTIVE_STANDARD'),
    (34, 'ba_personal_b9ff4035-0429-4b6b-83fb-f50ef132e43d', 'personal', 'active', TIMESTAMP '2026-06-16 06:29:14.622', NULL, 'RECONCILED_V2', 2, 'b66360bbf4b0e81b9bb5ab927aefcd15113dfb9b6674e84010d2b22d22fc00cb', 'ACTIVE_STANDARD'),
    (35, 'ba_personal_ba6ada11-bd14-4e7d-b185-6543a9c8d32a', 'personal', 'active', TIMESTAMP '2026-07-10 06:15:50.993', NULL, 'RECONCILED_V2', 2, '08c4337aeea5b4818ae0d4e547bfdb9bc394bd7f833fbf11290619a0ab344f46', 'ACTIVE_STANDARD'),
    (36, 'ba_personal_bb1dc4c9-681e-40ab-9dd8-a432f0fbc4da', 'personal', 'active', TIMESTAMP '2026-06-16 10:28:59.158', NULL, 'RECONCILED_V2', 2, 'd24de416245bca4c148c7d35b652589e52cc24630162461df617c68237cf876d', 'ACTIVE_STANDARD'),
    (37, 'ba_personal_c6dfa42c-3a4c-4d58-9665-348e1360fded', 'personal', 'active', TIMESTAMP '2026-07-03 06:33:49.976', NULL, 'RECONCILED_V2', 2, '750437cf10497be5b3efb8e0b61dedfb801d9a487e5d5b37e19344f64c1a6da6', 'ACTIVE_STANDARD'),
    (38, 'ba_personal_cd079605-c325-4e76-8d26-ae047d6ee270', 'personal', 'active', TIMESTAMP '2026-07-10 07:55:56.694', NULL, 'RECONCILED_V2', 2, '09a0d9f9062e8bfad7bd9e9d98f94f75a89c8e05762e0f6a791486732af5627e', 'ACTIVE_STANDARD'),
    (39, 'ba_personal_codex_probe_user', 'personal', 'active', TIMESTAMP '2026-06-27 15:36:53.307', NULL, 'RECONCILED_V2', 2, 'c693f28a4d7d11bace9fc39eeb19ad72038b945a29113b5556b90d468df1b5ee', 'ACTIVE_STANDARD'),
    (40, 'ba_personal_d32cd151-f027-4c92-98f7-1a8a850ea394', 'personal', 'active', TIMESTAMP '2026-06-17 09:10:21.538', NULL, 'RECONCILED_V2', 2, '0681e1e1adac20dd4a3eae7b12aa63b7ee89851d4e0335447de9a650c906c002', 'ACTIVE_STANDARD'),
    (41, 'ba_personal_d84aeacd-43a0-4a76-af06-3fdaf58a004d', 'personal', 'active', TIMESTAMP '2026-06-18 04:54:26.372', NULL, 'RECONCILED_V2', 2, 'b5aedbd13b156a99641fba13e1c5aaca8eb9d4fbdadc008fdb9fa14d5b1eead8', 'ACTIVE_STANDARD'),
    (42, 'ba_personal_demo_user_probe', 'personal', 'active', TIMESTAMP '2026-06-25 06:52:10.185', NULL, 'RECONCILED_V2', 2, '8be8ba547db8ae7cdeb2f240d8aa8e56e5ea591f9cef89952cda6a62381b8ab5', 'ACTIVE_STANDARD'),
    (43, 'ba_personal_e5aa3c8b-7411-494f-847b-30b09339e851', 'personal', 'active', TIMESTAMP '2026-06-30 05:18:09.875', NULL, 'RECONCILED_V2', 2, '3f5357769369fae72bbc3b914a799988ea6e3cbd52265452145893e73be13397', 'ACTIVE_STANDARD'),
    (44, 'ba_personal_ead05269-7711-4c85-9f8d-7f6068451e9f', 'personal', 'active', TIMESTAMP '2026-06-15 12:44:44.940', NULL, 'RECONCILED_V2', 2, '06599da46784a7fba2711e516c2fc955039180cd26996623caff8f129f7b8b40', 'ACTIVE_STANDARD'),
    (45, 'ba_personal_f4ce9280-28dc-437d-b78c-0eded8aa2257', 'personal', 'active', TIMESTAMP '2026-06-24 02:32:59.641', NULL, 'RECONCILED_V2', 2, '93559a42426eed2892fd955ce6b912ffa7ad6598ef435733709e3191ce348130', 'ACTIVE_STANDARD'),
    (46, 'ba_personal_matra_probe_user_20260629_002', 'personal', 'active', TIMESTAMP '2026-06-29 02:17:34.917', NULL, 'RECONCILED_V2', 2, 'c363bda01cb246638dce140436c3f43aa73810cb69c6edc5ccdf80e64a91514c', 'ACTIVE_STANDARD'),
    (47, 'ba_personal_probe-allmodels-001', 'personal', 'active', TIMESTAMP '2026-06-25 09:27:00.343', NULL, 'RECONCILED_V2', 2, 'f7378cfff74e3c70a29b69091981b17babd3d3925b2c03ccc435be2f63410bee', 'ACTIVE_STANDARD'),
    (48, 'ba_personal_probe-prop2-3409b247', 'personal', 'active', TIMESTAMP '2026-06-25 10:01:07.060', NULL, 'RECONCILED_V2', 2, 'e6724d42cf64503b38cc690ec50cad096210a1db6139d9b9631a753f6b54a7cb', 'ACTIVE_STANDARD'),
    (49, 'ba_personal_probe-prop2-48a5d338', 'personal', 'active', TIMESTAMP '2026-06-25 10:01:04.807', NULL, 'RECONCILED_V2', 2, '69b2d142431b0c8cd7ebbbdaad5c82d8dbd79c8b25a5568596ba738a522063f3', 'ACTIVE_STANDARD'),
    (50, 'ba_personal_probe-prop2-77053542', 'personal', 'active', TIMESTAMP '2026-06-25 10:01:06.048', NULL, 'RECONCILED_V2', 2, 'd8494d3d61ec21dc6a5bbc641dc29a9dde2e655e082a2bdc741d062b013da066', 'ACTIVE_STANDARD'),
    (51, 'ba_personal_probe-prop-61111314', 'personal', 'active', TIMESTAMP '2026-06-25 09:59:55.088', NULL, 'RECONCILED_V2', 2, '775f1fa6268e7bdec2b1303bc7ced7413efc5ee6e57029bd5b24f8e905a92fd8', 'ACTIVE_STANDARD'),
    (52, 'ba_personal_prod-smoke-1782624417', 'personal', 'active', TIMESTAMP '2026-06-28 05:26:57.328', NULL, 'RECONCILED_V2', 2, 'b77060a740572d92a3900a3add4cd943ddf56fd081425a2c523b14ef57032f5f', 'ACTIVE_STANDARD'),
    (53, 'ba_personal_rdclaw-client-live-001', 'personal', 'active', TIMESTAMP '2026-06-25 09:54:59.384', NULL, 'RECONCILED_V2', 2, 'fa500d08a2e5f6a415ba6b24b1da8ddf750d7ce3608b67d8e83b7541082bbb08', 'ACTIVE_STANDARD'),
    (54, 'ba_personal_rdclaw-e2e-user-001', 'personal', 'active', TIMESTAMP '2026-06-25 09:48:09.367', NULL, 'RECONCILED_V2', 2, 'cd6af304e1b395dd7464556e9843d6022e4ec851a69334227a4eab86a2a54e8b', 'ACTIVE_STANDARD'),
    (55, 'ba_personal_rdclaw-retry-1782388449', 'personal', 'active', TIMESTAMP '2026-06-25 11:54:09.491', NULL, 'RECONCILED_V2', 2, '1f20871f3026b646dd5a173738e15929e247831407bb32b524fbadf5bfb59e5e', 'ACTIVE_STANDARD'),
    (56, 'ba_personal_rdclaw-stream-1782388504', 'personal', 'active', TIMESTAMP '2026-06-25 11:55:04.160', NULL, 'RECONCILED_V2', 2, '56536712c24651862faf2d6b8c406ef5d205830ac373b920071ff3246fb7241e', 'ACTIVE_STANDARD'),
    (57, 'ba_personal_rdwork-e2e-001', 'personal', 'active', TIMESTAMP '2026-06-25 07:14:45.730', NULL, 'RECONCILED_V2', 2, '2fe7fe7d045860b87ec62fea7117cd7de99d5daa36b8d3ecec0de2635fe5cec3', 'ACTIVE_STANDARD'),
    (58, 'ba_personal_rdwork-e2e-002', 'personal', 'active', TIMESTAMP '2026-06-25 07:17:06.564', NULL, 'RECONCILED_V2', 2, '13091240fa90bb5566a0b449aeb7ce06be961022a88c1930df43c62067f66ee6', 'ACTIVE_STANDARD'),
    (59, 'ba_personal_rdwork-e2e-glm52-001', 'personal', 'active', TIMESTAMP '2026-06-25 08:54:15.310', NULL, 'RECONCILED_V2', 2, 'f48ce8d02de393c92158f630b4d110f07704254449a5c253f9117420a373718c', 'ACTIVE_STANDARD'),
    (60, 'ba_personal_rdwork-probe-001', 'personal', 'active', TIMESTAMP '2026-06-25 07:12:40.839', NULL, 'RECONCILED_V2', 2, '3d9a482bb0df54e92d65c3b026d198d8d8c020292a6327c46b1e2e8dd9a10829', 'ACTIVE_STANDARD'),
    (61, 'ba_personal_rdwork-probe-002', 'personal', 'active', TIMESTAMP '2026-06-25 07:18:06.720', NULL, 'RECONCILED_V2', 2, '17844b9d9d8561bac7f1bbb250e6f8445df2eb857f07e32938a7db303b8faced', 'ACTIVE_STANDARD'),
    (62, 'ba_personal_rdwork-probe-003', 'personal', 'active', TIMESTAMP '2026-06-25 07:19:16.967', NULL, 'RECONCILED_V2', 2, '735ff826091ff64d85af6959bbcc7f7d0f1386c15662ece7ba6d1a0253f3fe39', 'ACTIVE_STANDARD'),
    (63, 'ba_personal_rdwork-probe-004', 'personal', 'active', TIMESTAMP '2026-06-25 07:20:15.711', NULL, 'RECONCILED_V2', 2, 'fc5fb8afbaa86908f2a36066eeef458ba74be8e1d4ba8b771c22f4bfa10d3c54', 'ACTIVE_STANDARD'),
    (64, 'ba_personal_rdwork-real-001', 'personal', 'active', TIMESTAMP '2026-06-25 08:08:32.573', NULL, 'RECONCILED_V2', 2, '00492463d38517ce57fe828a93b8719c3e8881e87d1f72924d1c366e39fd5439', 'ACTIVE_STANDARD'),
    (65, 'ba_personal_sdk_probe_user', 'personal', 'active', TIMESTAMP '2026-06-25 09:34:30.251', NULL, 'RECONCILED_V2', 2, '65ba4737409a90d99bd72833de6d8e8c9730ec2293a0203aa7ddd176b9aa5096', 'ACTIVE_STANDARD'),
    (66, 'ba_personal_smoke-sysd-1', 'personal', 'active', TIMESTAMP '2026-06-28 06:07:56.378', NULL, 'RECONCILED_V2', 2, '403d16304eb53a1f8c3fee656fb666bfe963ee37e9c5e0035b3f4c024d035b47', 'ACTIVE_STANDARD'),
    (67, 'ba_personal_smoke-wl-1', 'personal', 'active', TIMESTAMP '2026-06-28 06:04:14.614', NULL, 'RECONCILED_V2', 2, '803de0c533750ae9b5741c015e385d7fbc0b6436fd9a6d3ed6dfda258370f167', 'ACTIVE_STANDARD'),
    (68, 'ba_personal_user_alice', 'personal', 'active', TIMESTAMP '2026-06-25 07:05:25.258', NULL, 'RECONCILED_V2', 2, '273f961cec82a6dd14374807aab978ff2d66aae69fb112fdd1d8a848e8935279', 'ACTIVE_STANDARD'),
    (69, 'ba_personal_user_olivia', 'personal', 'active', TIMESTAMP '2026-06-25 12:41:23.354', NULL, 'RECONCILED_V2', 2, 'a21ed1a0ecbc5f197fa3de5544b0d2ebd76a54bb43c36b93fbd6ca7e71000d02', 'ACTIVE_STANDARD'),
    (70, 'ba_personal_whitelist-probe-001', 'personal', 'active', TIMESTAMP '2026-06-28 05:38:38.588', NULL, 'RECONCILED_V2', 2, 'daf4264cc9670d9aa3516f3f4fde292162e1916dfea601670075abb4ef650e8e', 'ACTIVE_STANDARD'),
    (71, 'd87f01dc-455e-4f88-96f9-b35326b6b4ac', 'enterprise', 'deleted', TIMESTAMP '2026-07-06 09:32:04.780', TIMESTAMP '2026-07-06 09:35:17.515', 'RECONCILED_V2', 2, 'af2353f9202c162c7bdc4c7051b3623c999d29d2e0927de731bb18f78ce277e1', 'DELETED_INERT_MEMBER_METADATA')
$$;

-- The deleted cohort retains one historical owner-membership row per account.
-- These are identity metadata, not reachable tenants or financial activity;
-- pinning them prevents an over-broad "empty account" assumption.
CREATE OR REPLACE FUNCTION
  "billing_account_currency_label_deleted_member_nprod_v2"()
RETURNS TABLE(
  id TEXT,
  billing_account_id TEXT,
  user_id TEXT,
  role TEXT,
  status TEXT,
  joined_at TIMESTAMP(3),
  created_at TIMESTAMP(3),
  updated_at TIMESTAMP(3)
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    ('f3290f30-7823-4b48-bb8b-0acc0a4aa6a5', '7aa6e486-f8f7-4008-8ec5-87088ac86106', '9948fb82-7144-48bd-aa4f-4dc0cfa4a42a', 'owner', 'active', TIMESTAMP '2026-07-06 09:05:09.507', TIMESTAMP '2026-07-06 09:05:09.507', TIMESTAMP '2026-07-06 09:13:41.507'),
    ('c9b72ee7-1874-4dc4-9512-b35f62f10f76', '9f60325a-9c7c-4aa8-a9e7-ba40782abf54', '9948fb82-7144-48bd-aa4f-4dc0cfa4a42a', 'owner', 'active', TIMESTAMP '2026-07-06 09:48:26.322', TIMESTAMP '2026-07-06 09:48:26.322', TIMESTAMP '2026-07-06 09:48:34.103'),
    ('7a97a62e-ebb2-4568-992c-ac1f921ec92a', 'd87f01dc-455e-4f88-96f9-b35326b6b4ac', '9948fb82-7144-48bd-aa4f-4dc0cfa4a42a', 'owner', 'active', TIMESTAMP '2026-07-06 09:32:04.785', TIMESTAMP '2026-07-06 09:32:04.785', TIMESTAMP '2026-07-06 09:34:12.111')
$$;

-- Exact historical ledger-repair exceptions observed inside this cohort.  The
-- old audit rows remain append-only; this manifest proves their authoritative
-- successor/current ledger state instead of rewriting history or broadly
-- accepting non-terminal repair runs.
CREATE OR REPLACE FUNCTION
  "billing_account_currency_label_ledger_exception_nprod_v2"()
RETURNS TABLE(
  ordinal INTEGER,
  repair_run_id TEXT,
  repair_account_id TEXT,
  billing_account_id TEXT,
  authoritative_run_id TEXT,
  authoritative_repair_account_id TEXT
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    (1, 'adf35e3e-0d40-4cb0-8e72-359a975dcdf9', '107baecb-f9b5-4a47-9d79-214b9d22bfde', 'ba_personal_652a3519-1fa8-40ec-9a3c-0d6417f60b73', '5a49bb1b-c7cd-4d7b-8ba2-a1c69cad0fa6', '71c26f06-3158-4e03-9497-6861030c32bc'),
    (2, 'fd562f5a-e899-4559-932f-3ff916c47c64', '6a573670-e203-4899-ac90-eafb02f67dda', 'ba_personal_01352d9f-864c-49a5-a406-5ba4b7d6516e', NULL, NULL),
    (3, 'fd562f5a-e899-4559-932f-3ff916c47c64', '39d2a3e7-4bb4-44c9-8ae9-5ec6edddc2c1', 'ba_personal_0173d73e-a8ef-4b19-b1e7-3525f81ae2f8', NULL, NULL),
    (4, 'fd562f5a-e899-4559-932f-3ff916c47c64', '575f641b-69f7-43ee-aa4b-b8ea91dd4d54', 'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b', NULL, NULL),
    (5, 'fd562f5a-e899-4559-932f-3ff916c47c64', 'dd818649-0813-4bc8-9974-d5f67197e5c4', 'ba_personal_17fe51aa-0d1f-443a-a66b-2b8809e80fc1', NULL, NULL),
    (6, 'fd562f5a-e899-4559-932f-3ff916c47c64', '7a1969cb-fbff-4674-b104-115c81f6d80d', 'ba_personal_46121dc9-bae6-41d2-a297-403d58e59b22', NULL, NULL),
    (7, 'fd562f5a-e899-4559-932f-3ff916c47c64', 'bf9e2405-01bc-4a74-8137-74bd768645f2', 'ba_personal_4afcc651-989d-47ea-acc2-5ba18963bfda', NULL, NULL),
    (8, 'fd562f5a-e899-4559-932f-3ff916c47c64', '69c8ec0b-01be-4a90-99db-c4bb8c5dbe6e', 'ba_personal_5d552dfa-afe3-42e5-bb5f-cda7d73ab6af', NULL, NULL)
$$;

CREATE OR REPLACE FUNCTION "billing_account_currency_label_pending_order_nprod_v2"()
RETURNS TABLE(
  order_id TEXT,
  billing_account_id TEXT,
  order_type TEXT,
  amount_cents INTEGER,
  currency TEXT,
  channel TEXT,
  order_status TEXT,
  created_at TIMESTAMP(3),
  checkout_init_state TEXT
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    ('09ee75b0-e62a-40b8-8c9b-550cf15b8063', 'ba_personal_01352d9f-864c-49a5-a406-5ba4b7d6516e', 'SUBSCRIPTION', 10000, 'cny', 'ALIPAY', 'PENDING', TIMESTAMP '2026-07-31 05:47:24.795', 'NOT_STARTED'),
    ('2c9540bc-b94b-4975-a07b-4edb182bdc4a', 'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b', 'RECHARGE', 100, 'cny', 'ALIPAY', 'PENDING', TIMESTAMP '2026-07-31 12:51:27.016', 'NOT_STARTED'),
    ('6890010b-0417-4638-912a-f5f602645d7f', 'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b', 'RECHARGE', 100, 'cny', 'ALIPAY', 'PENDING', TIMESTAMP '2026-07-31 12:26:26.391', 'NOT_STARTED'),
    ('7d9f1bce-4acd-4204-804c-b8b92b879a71', 'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b', 'RECHARGE', 100, 'cny', 'ALIPAY', 'PENDING', TIMESTAMP '2026-07-31 12:52:24.778', 'NOT_STARTED'),
    ('9950aa2f-4f82-41b0-94c5-de1e1480efd2', 'ba_personal_01352d9f-864c-49a5-a406-5ba4b7d6516e', 'SUBSCRIPTION', 10000, 'cny', 'ALIPAY', 'PENDING', TIMESTAMP '2026-07-31 05:47:50.092', 'NOT_STARTED'),
    ('a67ac72f-5d93-4084-99de-ecf5ecca829c', 'ba_personal_01352d9f-864c-49a5-a406-5ba4b7d6516e', 'SUBSCRIPTION', 10000, 'cny', 'ALIPAY', 'PENDING', TIMESTAMP '2026-07-31 05:46:39.238', 'NOT_STARTED')
$$;

CREATE OR REPLACE FUNCTION "billing_account_currency_label_event_nprod_v2"()
RETURNS TABLE(
  ordinal INTEGER,
  gateway_billing_event_id TEXT,
  request_id TEXT,
  event_id TEXT,
  evidence_id TEXT,
  evidence_hash TEXT,
  api_key_id TEXT,
  tenant_id TEXT,
  billing_account_id TEXT,
  evidence_revision INTEGER,
  evidence_source TEXT,
  evidence_status TEXT,
  evidence_protocol TEXT,
  terminal_frame_seen BOOLEAN,
  provider_reconciliation_required BOOLEAN,
  event_created_at TIMESTAMP(3),
  evidence_created_at TIMESTAMP(3),
  expected_snapshot_hash TEXT,
  restriction_id TEXT,
  projection_intent_id TEXT
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    (1, 'c2dcf794-34e1-44d1-a9e3-d33e2aa5d11c', 'bee9e76a-9181-4a3d-a31a-78360dcf4263', '9e214ad2-6a6e-49d8-808a-5083dcbbcf19', '70440d31-5730-4906-8dbd-dd5b430e1cc5', '50a4d2046e9f58b73baba9828e9d7cd874475d9db10161bc61c40f4701eb45fa', '7d729b62-5a9f-4286-85fb-f12948d810f1', 'de01a87e-21df-47e9-b882-a62de1656ca8', 'ba_personal_01352d9f-864c-49a5-a406-5ba4b7d6516e', 1, 'provider_terminal', 'complete', 'openai', FALSE, FALSE, TIMESTAMP '2026-08-07 07:34:18.291', TIMESTAMP '2026-08-07 07:34:18.381', '2a4ef7a9a46855866075fb8177c9977cc849cf3ef6b7c75c142c07039c024dc2', '0f90ac22-498a-4e7f-b527-349a49a75999', 'dece0cb7-e005-4f58-b6d2-d3a167fe733b'),
    (2, '4dac4cae-3437-48a2-968c-30f1144be230', '486afec5-249d-4b33-958d-40f69b89d1ee', '70954207-22df-459f-a297-b229a4fe5fb0', '62761674-c2e4-4807-be7d-8cd606ae0ed7', 'a42db6cea55b89f8aff3d9c0f80e8bb78dbcdc91092f63c8f3bade67e7c17cbd', '12ff4088-666f-4518-b346-b942df75f75c', 'a6a28517-a10d-4fff-b8f3-d10e1062cd47', 'ba_personal_0173d73e-a8ef-4b19-b1e7-3525f81ae2f8', 1, 'provider_terminal', 'complete', 'openai', FALSE, FALSE, TIMESTAMP '2026-08-07 09:49:23.213', TIMESTAMP '2026-08-07 09:49:23.232', 'e3dd83ecac3c9e3c3137587f4458c52525cb751ee5e6e6101b83750ac3cec093', 'a703e6c2-d612-44ac-8faf-dd4418f3e35f', '4dfe1039-1d16-4745-95c0-e09083f9d73f')
$$;

-- Extend the immutable currency guard by one exact, database-bound authority.
-- The GUC, append-only run/item proof and byte-exact OLD/NEW snapshots remain
-- mandatory; this does not create a generic manifest escape hatch.
CREATE OR REPLACE FUNCTION enforce_billing_account_currency_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_run_id TEXT;
BEGIN
  IF NEW."currency" IS NOT DISTINCT FROM OLD."currency" THEN
    RETURN NEW;
  END IF;
  active_run_id := NULLIF(btrim(current_setting(
    'billing.currency_label_repair_run_id', TRUE
  )), '');
  IF OLD."currency" = 'USD'
    AND NEW."currency" = 'CNY'
    AND active_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "billing_account_currency_label_repair_runs" repair_run
      JOIN "billing_account_currency_label_repair_items" item
        ON item."run_id" = repair_run."id"
      WHERE repair_run."id" = active_run_id
        AND (
          repair_run."manifest_version" IN (
            'shanghai-uat-legacy-usd-label-v1',
            'beijing-nprod-legacy-usd-label-v2'
          )
          OR (
            lower(current_database()) ~ '(test|ci)'
            AND COALESCE(NULLIF(current_setting(
              'billing.allow_currency_label_repair_fixture', TRUE
            ), ''), 'false')::BOOLEAN
          )
        )
        AND repair_run."status" = 'APPLIED'
        AND repair_run."source_currency" = 'USD'
        AND repair_run."target_currency" = 'CNY'
        AND item."billing_account_id" = OLD."id"
        AND item."before_currency" = 'USD'
        AND item."after_currency" = 'CNY'
        AND item."before_account_snapshot" = to_jsonb(OLD)
        AND item."after_account_snapshot" = to_jsonb(NEW)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'billing account currency requires a drained dedicated migration'
    USING ERRCODE = '55000';
END
$$;

-- Canonical preflight evidence.  The financial snapshot helper installed by
-- 00100 covers account identity, wallets, ledgers, grants, usage, credit,
-- orders and Gateway facts; it intentionally excludes only account.currency
-- and account.updated_at so the label-only invariant can be proved after CAS.
CREATE OR REPLACE FUNCTION "billing_account_currency_label_evidence_v2"()
RETURNS TABLE(
  manifest_hash TEXT,
  evidence_snapshot JSONB,
  evidence_sha256 TEXT
)
LANGUAGE sql
STABLE
AS $$
  WITH account_rows AS (
    SELECT manifest.*,
      to_jsonb(account_row) AS account_snapshot,
      "billing_account_currency_label_financial_snapshot"(
        manifest.billing_account_id
      ) AS financial_snapshot
    FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
    LEFT JOIN "billing_accounts" account_row
      ON account_row."id" = manifest.billing_account_id
  ), manifest_evidence AS (
    SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
      'ordinal', manifest.ordinal,
      'billingAccountId', manifest.billing_account_id,
      'type', account_row."type",
      'createdAt', to_char(
        account_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'
      ),
      'ledgerStatus', account_row."balance_grant_ledger_status",
      'ledgerVersion', account_row."balance_grant_ledger_version"
    ) ORDER BY manifest.ordinal), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      AS manifest_hash
    FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
    LEFT JOIN "billing_accounts" account_row
      ON account_row."id" = manifest.billing_account_id
  ), deleted_member_rows AS (
    SELECT member_row.*
    FROM "billing_account_members" member_row
    JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
      ON manifest.billing_account_id = member_row."billing_account_id"
    WHERE manifest.classification = 'DELETED_INERT_MEMBER_METADATA'
  ), ledger_exception_rows AS (
    SELECT source_account."id" AS repair_account_id,
      source_run."id" AS run_id,
      source_account."billing_account_id",
      source_account."status" AS item_status,
      source_run."status" AS run_status,
      source_run."plan_hash", source_run."initiated_by",
      source_run."created_at" AS run_created_at,
      source_run."completed_at" AS run_completed_at,
      source_account."created_at" AS item_created_at,
      source_account."updated_at" AS item_updated_at,
      source_account."precondition_hash", source_account."replay_hash",
      encode(sha256(convert_to(
        source_account."before_snapshot"::TEXT, 'UTF8'
      )), 'hex') AS before_snapshot_hash,
      CASE WHEN source_account."after_snapshot" IS NULL THEN NULL
        ELSE encode(sha256(convert_to(
          source_account."after_snapshot"::TEXT, 'UTF8'
        )), 'hex') END AS after_snapshot_hash,
      source_account."error",
      account_row."balance_grant_ledger_status" AS current_ledger_status,
      account_row."balance_grant_ledger_version" AS current_ledger_version,
      account_row."balance_grant_ledger_hash" AS current_ledger_hash,
      account_row."balance_grant_ledger_reconciled_at"
        AS current_reconciled_at,
      cover.run_id AS covering_run_id,
      cover.run_status AS covering_run_status,
      cover.item_status AS covering_item_status,
      cover.replay_hash AS covering_replay_hash,
      cover.run_created_at AS covering_run_created_at,
      cover.run_completed_at AS covering_run_completed_at,
      cover.item_updated_at AS covering_item_updated_at
    FROM "billing_account_currency_label_ledger_exception_nprod_v2"() expected
    LEFT JOIN "balance_ledger_repair_runs" source_run
      ON source_run."id" = expected.repair_run_id
    LEFT JOIN "balance_ledger_repair_accounts" source_account
      ON source_account."id" = expected.repair_account_id
      AND source_account."run_id" = source_run."id"
      AND source_account."billing_account_id" = expected.billing_account_id
    LEFT JOIN "billing_accounts" account_row
      ON account_row."id" = source_account."billing_account_id"
    LEFT JOIN LATERAL (
      SELECT later_run."id" AS run_id,
        later_run."status" AS run_status,
        later_account."status" AS item_status,
        later_account."replay_hash",
        later_run."created_at" AS run_created_at,
        later_run."completed_at" AS run_completed_at,
        later_account."updated_at" AS item_updated_at
      FROM "balance_ledger_repair_accounts" later_account
      JOIN "balance_ledger_repair_runs" later_run
        ON later_run."id" = later_account."run_id"
      WHERE later_account."billing_account_id"
          = source_account."billing_account_id"
        AND later_run."created_at" > source_run."created_at"
        AND later_run."status" = 'COMPLETED'
        AND later_account."status" = 'APPLIED'
      ORDER BY later_run."created_at" DESC
      LIMIT 1
    ) cover ON TRUE
  ), invoice_application_ids AS (
    SELECT DISTINCT invoice_item."application_id"
    FROM "invoice_application_items" invoice_item
    JOIN "orders" order_row ON order_row."id" = invoice_item."order_id"
    JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
      ON manifest.billing_account_id = order_row."billing_account_id"
  ), invoice_snapshot AS (
    SELECT jsonb_build_object(
      'applications', COALESCE((SELECT jsonb_agg(
        to_jsonb(application_row) ORDER BY application_row."id"
      ) FROM "invoice_applications" application_row
        JOIN invoice_application_ids ids
          ON ids."application_id" = application_row."id"), '[]'::JSONB),
      'items', COALESCE((SELECT jsonb_agg(
        to_jsonb(item_row) ORDER BY item_row."id"
      ) FROM "invoice_application_items" item_row
        JOIN invoice_application_ids ids
          ON ids."application_id" = item_row."application_id"), '[]'::JSONB),
      'events', COALESCE((SELECT jsonb_agg(
        to_jsonb(event_row) ORDER BY event_row."id"
      ) FROM "invoice_event_log" event_row
        JOIN invoice_application_ids ids
          ON ids."application_id" = event_row."application_id"), '[]'::JSONB)
    ) AS snapshot
  ), pending_rows AS (
    SELECT order_row."id", order_row."billing_account_id",
      order_row."order_type"::TEXT AS order_type,
      order_row."amount_cents", order_row."currency",
      order_row."channel"::TEXT AS channel,
      order_row."status"::TEXT AS status,
      to_char(order_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS')
        AS created_at,
      order_row."checkout_init_state"::TEXT AS checkout_init_state,
      order_row."trade_no", order_row."paid_at", order_row."refunded_at",
      order_row."expired_at", order_row."completed_at",
      order_row."cancelled_at", order_row."fulfillment_attempt_id",
      order_row."fulfillment_claimed_at", order_row."checkout_lease_id",
      order_row."checkout_lease_expires_at",
      order_row."checkout_context_encrypted",
      order_row."checkout_provider_reference",
      order_row."checkout_pay_url_encrypted",
      order_row."checkout_pay_url_expires_at",
      (SELECT COUNT(*) FROM "order_audit_logs" fact
        WHERE fact."order_id" = order_row."id") AS audit_count,
      (SELECT COUNT(*) FROM "order_items" fact
        WHERE fact."order_id" = order_row."id") AS item_count,
      (SELECT COUNT(*) FROM "balance_transactions" fact
        WHERE fact."order_id" = order_row."id") AS tx_count,
      (SELECT COUNT(*) FROM "balance_grants" fact
        WHERE fact."order_id" = order_row."id") AS grant_count,
      (SELECT COUNT(*) FROM "stripe_payment_ledgers" fact
        WHERE fact."order_id" = order_row."id") AS stripe_count,
      (SELECT COUNT(*) FROM "provider_refund_intents" fact
        WHERE fact."order_id" = order_row."id") AS refund_count,
      (SELECT COUNT(*) FROM "invoice_application_items" fact
        WHERE fact."order_id" = order_row."id") AS invoice_count
    FROM "orders" order_row
    JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
      ON manifest.billing_account_id = order_row."billing_account_id"
    WHERE order_row."status"::TEXT = 'PENDING'
  ), event_rows AS (
    SELECT expected.ordinal,
      jsonb_build_object(
        'event', to_jsonb(event_row)
          - 'raw_event' - 'billing_result'
          - 'subject_snapshot' - 'pricing_snapshot',
        'evidence', to_jsonb(evidence_row) - 'raw_evidence',
        'resolvedBillingAccountId', tenant_row."billing_account_id",
        'restriction', to_jsonb(restriction_row),
        'restrictionProjectionIntent', to_jsonb(intent_row)
      ) AS event_snapshot
    FROM "billing_account_currency_label_event_nprod_v2"() expected
    LEFT JOIN "gateway_billing_events" event_row
      ON event_row."id" = expected.gateway_billing_event_id
    LEFT JOIN "gateway_usage_evidences" evidence_row
      ON evidence_row."id" = expected.evidence_id
      AND evidence_row."gateway_billing_event_id" = event_row."id"
    LEFT JOIN "api_keys" api_key_row
      ON api_key_row."id" = event_row."api_key_id"
    LEFT JOIN "tenants" tenant_row
      ON tenant_row."id" = api_key_row."tenant_id"
    LEFT JOIN "billing_access_restrictions" restriction_row
      ON restriction_row."id" = expected.restriction_id
      AND restriction_row."gateway_billing_event_id" = event_row."id"
    LEFT JOIN "billing_restriction_projection_intents" intent_row
      ON intent_row."id" = expected.projection_intent_id
      AND intent_row."billing_access_restriction_id" = restriction_row."id"
  ), evidence AS (
    SELECT manifest_evidence.manifest_hash,
      jsonb_build_object(
        'manifestVersion', 'beijing-nprod-legacy-usd-label-v2',
        'manifestHash', manifest_evidence.manifest_hash,
        'fixedFullAccountManifestHash',
          '0c5a77ad9b63b31b444041c33570997655c7187ac5bdfac37cc0cabe9758510b',
        'fixedDeletedMemberProofHash',
          '856224622e1dd48ecff2b64fb6f502d9bd707eca237316b1cca503f7e8cfe59e',
        'fixedLedgerExceptionProofHash',
          '18312e4653fb9a6755f2bf99280cd4037ab3a1a25828a22d8ee2e08e43a9ef4f',
        'fixedInvoiceProofHash',
          '36ac0df9c711fb81145f586014671f57880967c96f0b13c197f56d21d2a64f54',
        'fixedPendingManifestHash',
          '278afb0d2e2bc285d3634f092eb449387e70aed3137245ccb60040839d5d891c',
        'fixedPendingEvidenceHash',
          'a52989fd9f96c0a36afedc82dacbd4a6fd5bddc7cc89899325ad6c8223cc1869',
        'fixedEligibleEventManifestHash',
          '75e2e9851e54385620d4091d0cfb531d1bd18a00f324edb16a77877a5b6b6000',
        'fixedRestrictionProofHash',
          '39a875f0368f92e39d4e308620885b8423f4f074ad7c79a109c271e0fc028ef3',
        'databaseName', current_database(),
        'databaseIdentity', (SELECT rollout."database_identity"::TEXT
          FROM "balance_ledger_rollout_control" rollout
          WHERE rollout."id" = 1),
        'databaseSystemIdentifier', (SELECT
          rollout."database_system_identifier"::TEXT
          FROM "balance_ledger_rollout_control" rollout
          WHERE rollout."id" = 1),
        'databaseOid', (SELECT rollout."database_oid"::BIGINT
          FROM "balance_ledger_rollout_control" rollout
          WHERE rollout."id" = 1),
        'deploymentConfig', COALESCE((SELECT jsonb_build_object(
          'region', lower(config."value"::JSONB->>'region'),
          'currency', lower(config."value"::JSONB->>'currency')
        ) FROM "system_configs" config
          WHERE config."key" = 'deploymentConfig'), 'null'::JSONB),
        'accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'manifest', to_jsonb(account_rows)
            - 'account_snapshot' - 'financial_snapshot',
          'account', account_rows.account_snapshot,
          'financial', account_rows.financial_snapshot
        ) ORDER BY account_rows.ordinal) FROM account_rows), '[]'::JSONB),
        'deletedMemberMetadata', COALESCE((SELECT jsonb_agg(
          to_jsonb(deleted_member_rows)
          ORDER BY deleted_member_rows."billing_account_id",
            deleted_member_rows."id"
        ) FROM deleted_member_rows), '[]'::JSONB),
        'ledgerRepairExceptions', COALESCE((SELECT jsonb_agg(
          to_jsonb(ledger_exception_rows)
          ORDER BY ledger_exception_rows.run_created_at,
            ledger_exception_rows.billing_account_id
        ) FROM ledger_exception_rows), '[]'::JSONB),
        'invoiceFacts', COALESCE((SELECT snapshot FROM invoice_snapshot),
          jsonb_build_object(
            'applications', '[]'::JSONB,
            'items', '[]'::JSONB,
            'events', '[]'::JSONB
          )),
        'pendingOrders', COALESCE((SELECT jsonb_agg(to_jsonb(pending_rows)
          ORDER BY pending_rows."id") FROM pending_rows), '[]'::JSONB),
        'eligibleEvents', COALESCE((SELECT jsonb_agg(
          event_rows.event_snapshot ORDER BY event_rows.ordinal
        ) FROM event_rows), '[]'::JSONB)
      ) AS snapshot
    FROM manifest_evidence
  )
  SELECT evidence.manifest_hash, evidence.snapshot,
    encode(sha256(convert_to(evidence.snapshot::TEXT, 'UTF8')), 'hex')
  FROM evidence
$$;

CREATE OR REPLACE FUNCTION
  "apply_legacy_billing_account_currency_label_repair_v2"(
    expected_database_name TEXT,
    expected_database_identity UUID,
    expected_manifest_hash TEXT,
    requested_change_ticket TEXT,
    requested_operator TEXT,
    requested_approver_one TEXT,
    requested_approver_two TEXT,
    requested_evidence_sha256 TEXT,
    requested_confirmation TEXT,
    requested_writers_drained_until TIMESTAMP(3)
  )
RETURNS TABLE(
  run_id TEXT,
  manifest_version TEXT,
  status TEXT,
  account_count INTEGER,
  applied_at TIMESTAMP(3)
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_manifest_version CONSTANT TEXT :=
    'beijing-nprod-legacy-usd-label-v2';
  target_manifest_hash CONSTANT TEXT :=
    '273fe03908a9d463556a6e9e5c60faba681c480d62064447f4f1b765051340e5';
  target_full_manifest_hash CONSTANT TEXT :=
    '0c5a77ad9b63b31b444041c33570997655c7187ac5bdfac37cc0cabe9758510b';
  target_deleted_member_proof_hash CONSTANT TEXT :=
    '856224622e1dd48ecff2b64fb6f502d9bd707eca237316b1cca503f7e8cfe59e';
  target_ledger_exception_proof_hash CONSTANT TEXT :=
    '18312e4653fb9a6755f2bf99280cd4037ab3a1a25828a22d8ee2e08e43a9ef4f';
  target_invoice_proof_hash CONSTANT TEXT :=
    '36ac0df9c711fb81145f586014671f57880967c96f0b13c197f56d21d2a64f54';
  target_pending_manifest_hash CONSTANT TEXT :=
    '278afb0d2e2bc285d3634f092eb449387e70aed3137245ccb60040839d5d891c';
  target_pending_evidence_hash CONSTANT TEXT :=
    'a52989fd9f96c0a36afedc82dacbd4a6fd5bddc7cc89899325ad6c8223cc1869';
  target_event_manifest_hash CONSTANT TEXT :=
    '75e2e9851e54385620d4091d0cfb531d1bd18a00f324edb16a77877a5b6b6000';
  target_restriction_proof_hash CONSTANT TEXT :=
    '39a875f0368f92e39d4e308620885b8423f4f074ad7c79a109c271e0fc028ef3';
  target_database_name CONSTANT TEXT := 'ruidong_billing_v2';
  target_database_identity CONSTANT UUID :=
    '3f8df065-d032-4728-939a-db8fd4735533';
  target_system_identifier CONSTANT NUMERIC(20, 0) := 7610171897653500696;
  target_database_oid CONSTANT OID := 40312;
  source_currency CONSTANT TEXT := 'USD';
  target_currency CONSTANT TEXT := 'CNY';
  expected_account_count CONSTANT INTEGER := 71;
  expected_active_count CONSTANT INTEGER := 68;
  expected_deleted_count CONSTANT INTEGER := 3;
  expected_deleted_member_count CONSTANT INTEGER := 3;
  expected_ledger_exception_count CONSTANT INTEGER := 8;
  expected_invoice_application_count CONSTANT INTEGER := 20;
  expected_invoice_item_count CONSTANT INTEGER := 25;
  expected_invoice_event_count CONSTANT INTEGER := 54;
  expected_pending_count CONSTANT INTEGER := 6;
  expected_event_count CONSTANT INTEGER := 2;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
  rollout_control RECORD;
  deployment_config JSONB;
  deployment_config_hash TEXT;
  actual_manifest_hash TEXT;
  actual_full_manifest_hash TEXT;
  actual_deleted_member_proof_hash TEXT;
  actual_ledger_exception_proof_hash TEXT;
  actual_invoice_proof_hash TEXT;
  invoice_snapshot_before JSONB;
  invoice_snapshot_after JSONB;
  actual_pending_manifest_hash TEXT;
  actual_pending_evidence_hash TEXT;
  actual_event_manifest_hash TEXT;
  actual_restriction_proof_hash TEXT;
  actual_evidence_snapshot JSONB;
  actual_evidence_sha256 TEXT;
  valid_count BIGINT;
  invalid_count BIGINT;
  existing_run "billing_account_currency_label_repair_runs"%ROWTYPE;
  operation_run_id TEXT;
  operation_at TIMESTAMP(3);
  manifest_row RECORD;
  eligible_event_row RECORD;
  eligible_event_snapshot JSONB;
  eligible_event_row_hash TEXT;
  account_before JSONB;
  account_after JSONB;
  financial_before JSONB;
  financial_after JSONB;
  previous_transition_marker TEXT;
BEGIN
  -- Both request authorization and the database locator are exact.  Installing
  -- this migration elsewhere is a data no-op; calling it elsewhere fails.
  IF expected_database_name IS DISTINCT FROM target_database_name
    OR expected_database_name IS DISTINCT FROM current_database()
    OR expected_database_identity IS DISTINCT FROM target_database_identity
    OR expected_manifest_hash IS DISTINCT FROM target_manifest_hash
    OR NULLIF(btrim(requested_change_ticket), '') IS NULL
    OR NULLIF(btrim(requested_operator), '') IS NULL
    OR NULLIF(btrim(requested_approver_one), '') IS NULL
    OR NULLIF(btrim(requested_approver_two), '') IS NULL
    OR lower(btrim(requested_operator)) = lower(btrim(requested_approver_one))
    OR lower(btrim(requested_operator)) = lower(btrim(requested_approver_two))
    OR lower(btrim(requested_approver_one)) = lower(btrim(requested_approver_two))
    OR requested_evidence_sha256 IS NULL
    OR requested_evidence_sha256 !~ '^[0-9a-f]{64}$'
    OR requested_evidence_sha256 = repeat('0', 64)
    OR requested_confirmation IS DISTINCT FROM 'LABEL_ONLY_NO_FX'
    OR requested_writers_drained_until IS NULL
    OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
  THEN
    RAISE EXCEPTION 'nprod currency label repair authorization is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT "system_identifier"::NUMERIC(20, 0)
  INTO current_system_identifier FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database WHERE datname = current_database();
  SELECT * INTO rollout_control
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1 FOR SHARE;
  IF NOT FOUND
    OR rollout_control."phase" IS DISTINCT FROM 'V2_CONTRACT'
    OR rollout_control."database_name" IS DISTINCT FROM target_database_name
    OR rollout_control."database_identity"
      IS DISTINCT FROM target_database_identity
    OR rollout_control."database_system_identifier"
      IS DISTINCT FROM target_system_identifier
    OR rollout_control."database_oid" IS DISTINCT FROM target_database_oid
    OR current_system_identifier IS DISTINCT FROM target_system_identifier
    OR current_database_oid IS DISTINCT FROM target_database_oid
  THEN
    RAISE EXCEPTION 'nprod currency label repair database locator mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- Serialize this exact manifest before its idempotency read.  Namespace
  -- 60813 is dedicated to this release family; the second int binds the
  -- immutable manifest version using the repository's advisory-lock pattern.
  -- Under READ COMMITTED, a waiter sees the first caller's committed proof.
  PERFORM pg_advisory_xact_lock(60813, hashtext(target_manifest_version));

  -- Hold the protected relations before checking their trigger contract.  An
  -- ALTER TABLE that could disable or replace a guard requires an incompatible
  -- lock, so this proof remains true through both retry verification and apply.
  PERFORM set_config('lock_timeout', '5s', TRUE);
  LOCK TABLE
    "billing_account_currency_label_repair_runs",
    "billing_account_currency_label_repair_items",
    "billing_account_currency_label_repair_eligible_events",
    "billing_accounts"
    IN SHARE MODE;
  WITH expected_trigger(relation_id, trigger_name, function_id) AS (
    VALUES
      (
        'public.billing_account_currency_label_repair_runs'::REGCLASS,
        'billing_account_currency_label_repair_runs_append_only',
        'public.reject_billing_account_currency_label_repair_audit_mutation()'::REGPROCEDURE
      ),
      (
        'public.billing_account_currency_label_repair_items'::REGCLASS,
        'billing_account_currency_label_repair_items_append_only',
        'public.reject_billing_account_currency_label_repair_audit_mutation()'::REGPROCEDURE
      ),
      (
        'public.billing_account_currency_label_repair_eligible_events'::REGCLASS,
        'billing_account_currency_label_repair_events_append_only',
        'public.reject_billing_account_currency_label_repair_audit_mutation()'::REGPROCEDURE
      ),
      (
        'public.billing_accounts'::REGCLASS,
        'billing_accounts_currency_immutable',
        'public.enforce_billing_account_currency_immutability()'::REGPROCEDURE
      )
  )
  SELECT COUNT(*) INTO valid_count
  FROM expected_trigger expected
  JOIN pg_trigger trigger_row
    ON trigger_row.tgrelid = expected.relation_id
    AND trigger_row.tgname = expected.trigger_name
    AND trigger_row.tgfoid = expected.function_id
    AND trigger_row.tgenabled = 'O'
    AND NOT trigger_row.tgisinternal;
  IF valid_count IS DISTINCT FROM 4::BIGINT THEN
    RAISE EXCEPTION 'nprod currency label repair trigger contract incomplete=%',
      valid_count USING ERRCODE = '23514';
  END IF;

  -- Same-parameter retries return the already verified terminal proof.  Any
  -- argument or proof drift fails closed rather than starting a second run.
  SELECT existing_run_row.* INTO existing_run
  FROM "billing_account_currency_label_repair_runs" existing_run_row
  WHERE existing_run_row."manifest_version" = target_manifest_version;
  IF FOUND THEN
    IF existing_run."manifest_hash" IS DISTINCT FROM target_manifest_hash
      OR existing_run."database_name" IS DISTINCT FROM target_database_name
      OR existing_run."database_identity"
        IS DISTINCT FROM target_database_identity
      OR existing_run."database_system_identifier"
        IS DISTINCT FROM target_system_identifier
      OR existing_run."database_oid"
        IS DISTINCT FROM target_database_oid::BIGINT
      OR existing_run."change_ticket"
        IS DISTINCT FROM btrim(requested_change_ticket)
      OR existing_run."operator" IS DISTINCT FROM btrim(requested_operator)
      OR existing_run."approver_one"
        IS DISTINCT FROM btrim(requested_approver_one)
      OR existing_run."approver_two"
        IS DISTINCT FROM btrim(requested_approver_two)
      OR existing_run."evidence_sha256"
        IS DISTINCT FROM requested_evidence_sha256
      OR existing_run."confirmation" IS DISTINCT FROM requested_confirmation
      OR existing_run."writers_drained_until"
        IS DISTINCT FROM requested_writers_drained_until
      OR existing_run."status" IS DISTINCT FROM 'APPLIED'
      OR existing_run."source_currency" IS DISTINCT FROM source_currency
      OR existing_run."target_currency" IS DISTINCT FROM target_currency
      OR existing_run."account_count" IS DISTINCT FROM expected_account_count
      OR (SELECT COUNT(*)
          FROM "billing_account_currency_label_repair_items" item
          WHERE item."run_id" = existing_run."id")
        IS DISTINCT FROM expected_account_count::BIGINT
      OR (SELECT COUNT(*)
          FROM "billing_account_currency_label_repair_eligible_events" event
          WHERE event."run_id" = existing_run."id")
        IS DISTINCT FROM expected_event_count::BIGINT
      OR EXISTS (
        SELECT 1
        FROM "billing_account_currency_label_repair_items" item
        JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
          ON manifest.billing_account_id = item."billing_account_id"
        JOIN "billing_accounts" account_row
          ON account_row."id" = item."billing_account_id"
        WHERE item."run_id" = existing_run."id"
          AND (
            item."ordinal" IS DISTINCT FROM manifest.ordinal
            OR account_row."currency" IS DISTINCT FROM target_currency
            OR item."before_currency" IS DISTINCT FROM source_currency
            OR item."after_currency" IS DISTINCT FROM target_currency
            OR item."after_account_snapshot" IS DISTINCT FROM jsonb_set(
              item."before_account_snapshot", '{currency}',
              to_jsonb(target_currency)
            )
            OR encode(sha256(convert_to(
              item."before_account_snapshot"::TEXT, 'UTF8'
            )), 'hex') IS DISTINCT FROM item."before_account_snapshot_hash"
            OR encode(sha256(convert_to(
              item."after_account_snapshot"::TEXT, 'UTF8'
            )), 'hex') IS DISTINCT FROM item."after_account_snapshot_hash"
            OR encode(sha256(convert_to(
              item."financial_snapshot"::TEXT, 'UTF8'
            )), 'hex') IS DISTINCT FROM item."financial_snapshot_hash"
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "billing_account_currency_label_repair_eligible_events" eligible
        JOIN "billing_account_currency_label_repair_items" item
          ON item."id" = eligible."item_id"
        WHERE eligible."run_id" = existing_run."id"
          AND (
            item."run_id" IS DISTINCT FROM existing_run."id"
            OR encode(sha256(convert_to(jsonb_build_object(
              'runId', eligible."run_id",
              'billingAccountId', item."billing_account_id",
              'gatewayBillingEventId', eligible."gateway_billing_event_id",
              'requestId', eligible."request_id",
              'evidenceId', eligible."evidence_id",
              'evidenceHash', eligible."evidence_hash",
              'failureCode', eligible."failure_code",
              'failureReason', eligible."failure_reason",
              'errorMessage', eligible."error_message",
              'errorFingerprint', eligible."error_fingerprint",
              'eventSnapshot', eligible."event_snapshot"
            )::TEXT, 'UTF8')), 'hex') IS DISTINCT FROM eligible."row_hash"
          )
      )
    THEN
      RAISE EXCEPTION 'nprod currency label repair existing proof mismatch'
        USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT existing_run."id", existing_run."manifest_version",
      existing_run."status", existing_run."account_count",
      existing_run."applied_at";
    RETURN;
  END IF;

  IF requested_writers_drained_until
    < clock_timestamp()::TIMESTAMP(3) + INTERVAL '15 minutes'
  THEN
    RAISE EXCEPTION 'nprod currency label repair writer drain is insufficient'
      USING ERRCODE = '23514';
  END IF;

  LOCK TABLE
    "billing_accounts", "account_wallets", "billing_account_members",
    "tenants", "api_keys",
    "orders", "order_items", "order_audit_logs",
    "coding_plan_provider_entitlements", "coding_plan_entitlements",
    "coding_plan_renewal_charges", "coding_plan_promo_grants",
    "campaign_redemptions", "discount_code_redemptions",
    "balance_transactions", "balance_grants",
    "balance_consumption_allocations", "enterprise_credit_settlements",
    "balance_grant_expiries", "balance_grant_refunds",
    "balance_grant_refund_allocations", "credit_transactions",
    "billing_account_credit_configs", "billing_account_credit_events",
    "token_usage", "gateway_billing_events", "gateway_usage_evidences",
    "gateway_usage_reconciliation_actions",
    "gateway_usage_platform_losses", "historical_platform_loss_lines",
    "usage_loss_recognition_claims", "gateway_usage_settlement_anchors",
    "gateway_usage_funding_reservations",
    "gateway_usage_funding_reservation_grants",
    "gateway_usage_settlement_receipts", "billing_access_restrictions",
    "billing_restriction_projection_intents", "stripe_payment_ledgers",
    "provider_refund_intents", "refund_compensation_tasks",
    "stripe_subscription_cancellation_tasks", "invoice_applications",
    "invoice_application_items", "invoice_event_log",
    "balance_ledger_repair_runs", "balance_ledger_repair_accounts",
    "system_configs"
    IN SHARE MODE;

  SELECT "value"::JSONB INTO deployment_config
  FROM "system_configs" WHERE "key" = 'deploymentConfig';
  IF deployment_config IS NULL
    OR lower(deployment_config->>'region') IS DISTINCT FROM 'domestic'
    OR lower(deployment_config->>'currency') IS DISTINCT FROM 'cny'
  THEN
    RAISE EXCEPTION 'nprod currency label repair requires domestic CNY config'
      USING ERRCODE = '23514';
  END IF;
  deployment_config := jsonb_build_object(
    'region', lower(deployment_config->>'region'),
    'currency', lower(deployment_config->>'currency')
  );
  deployment_config_hash := encode(
    sha256(convert_to(deployment_config::TEXT, 'UTF8')), 'hex'
  );

  -- Recompute all three observed manifests from locked live rows.  The full
  -- USD population must be exactly this cohort: missing, partial or newly
  -- introduced USD accounts all fail closed.
  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
    'ordinal', manifest.ordinal,
    'billingAccountId', manifest.billing_account_id,
    'type', account_row."type",
    'createdAt', to_char(account_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'),
    'ledgerStatus', account_row."balance_grant_ledger_status",
    'ledgerVersion', account_row."balance_grant_ledger_version"
  ) ORDER BY manifest.ordinal), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
  INTO actual_manifest_hash
  FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
  LEFT JOIN "billing_accounts" account_row
    ON account_row."id" = manifest.billing_account_id;

  SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_object(
    'ordinal', manifest.ordinal,
    'billingAccountId', manifest.billing_account_id,
    'type', account_row."type",
    'status', account_row."status",
    'createdAt', to_char(account_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'),
    'deletedAt', to_char(account_row."deleted_at", 'YYYY-MM-DD HH24:MI:SS.MS'),
    'ledgerStatus', account_row."balance_grant_ledger_status",
    'ledgerVersion', account_row."balance_grant_ledger_version",
    'ledgerHash', account_row."balance_grant_ledger_hash",
    'classification', manifest.classification
  ) ORDER BY manifest.ordinal)::TEXT, 'UTF8')), 'hex')
  INTO actual_full_manifest_hash
  FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
  LEFT JOIN "billing_accounts" account_row
    ON account_row."id" = manifest.billing_account_id;

  SELECT COUNT(*) INTO valid_count
  FROM "billing_accounts" WHERE "currency" = source_currency;
  SELECT COUNT(*) INTO invalid_count
  FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
  LEFT JOIN "billing_accounts" account_row
    ON account_row."id" = manifest.billing_account_id
  LEFT JOIN "account_wallets" wallet_row
    ON wallet_row."billing_account_id" = manifest.billing_account_id
  WHERE account_row."id" IS NULL
    OR account_row."currency" IS DISTINCT FROM source_currency
    OR account_row."type" IS DISTINCT FROM manifest.account_type
    OR account_row."status" IS DISTINCT FROM manifest.account_status
    OR account_row."created_at" IS DISTINCT FROM manifest.account_created_at
    OR account_row."deleted_at" IS DISTINCT FROM manifest.account_deleted_at
    OR account_row."balance_grant_ledger_status"
      IS DISTINCT FROM manifest.ledger_status
    OR account_row."balance_grant_ledger_version"
      IS DISTINCT FROM manifest.ledger_version
    OR account_row."balance_grant_ledger_hash"
      IS DISTINCT FROM manifest.ledger_hash
    OR wallet_row."billing_account_id" IS NULL
    OR (manifest.account_status = 'active'
      AND account_row."deleted_at" IS NOT NULL)
    OR (manifest.account_status = 'deleted'
      AND account_row."deleted_at" IS NULL);
  IF valid_count IS DISTINCT FROM expected_account_count::BIGINT
    OR invalid_count <> 0
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_manifest_nprod_v2"()
      WHERE account_status = 'active') <> expected_active_count
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_manifest_nprod_v2"()
      WHERE account_status = 'deleted') <> expected_deleted_count
    OR actual_manifest_hash IS DISTINCT FROM target_manifest_hash
    OR actual_full_manifest_hash IS DISTINCT FROM target_full_manifest_hash
  THEN
    RAISE EXCEPTION 'nprod currency label repair account manifest mismatch usd=% invalid=%',
      valid_count, invalid_count USING ERRCODE = '23514';
  END IF;

  -- Deleted accounts retain one exact historical owner-membership row, but
  -- have no reachable tenant, API key, usage, order or financial activity.
  -- Active accounts intentionally do not reject a negative wallet; the
  -- repair proves ledger conservation and never changes an amount.
  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(
    to_jsonb(member_row)
    ORDER BY member_row."billing_account_id", member_row."id"
  ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
  INTO actual_deleted_member_proof_hash
  FROM "billing_account_members" member_row
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = member_row."billing_account_id"
  WHERE manifest.classification = 'DELETED_INERT_MEMBER_METADATA';

  SELECT COUNT(*) INTO valid_count
  FROM "billing_account_currency_label_deleted_member_nprod_v2"() expected
  JOIN "billing_account_members" member_row
    ON member_row."id" = expected.id
  WHERE member_row."billing_account_id" = expected.billing_account_id
    AND member_row."user_id" = expected.user_id
    AND member_row."role" = expected.role
    AND member_row."status" = expected.status
    AND member_row."joined_at" = expected.joined_at
    AND member_row."created_at" = expected.created_at
    AND member_row."updated_at" = expected.updated_at
    AND (SELECT COUNT(*) FROM "billing_account_members" same_account
      WHERE same_account."billing_account_id"
        = expected.billing_account_id) = 1;
  IF valid_count IS DISTINCT FROM expected_deleted_member_count::BIGINT
    OR actual_deleted_member_proof_hash
      IS DISTINCT FROM target_deleted_member_proof_hash
  THEN
    RAISE EXCEPTION 'nprod currency label repair deleted member proof mismatch count=% hash=%',
      valid_count, COALESCE(actual_deleted_member_proof_hash, 'NULL')
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_count
  FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
  JOIN "account_wallets" wallet_row
    ON wallet_row."billing_account_id" = manifest.billing_account_id
  WHERE manifest.classification = 'DELETED_INERT_MEMBER_METADATA'
    AND (
      wallet_row."balance_usd" <> 0
      OR EXISTS (SELECT 1 FROM "tenants" fact
        WHERE fact."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "api_keys" api_key_row
        JOIN "tenants" tenant_row ON tenant_row."id" = api_key_row."tenant_id"
        WHERE tenant_row."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "orders" fact
        WHERE fact."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "balance_transactions" fact
        WHERE fact."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "balance_grants" fact
        WHERE fact."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "billing_account_credit_configs" fact
        WHERE fact."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "billing_access_restrictions" fact
        WHERE fact."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "token_usage" usage_row
        JOIN "tenants" tenant_row ON tenant_row."id" = usage_row."tenant_id"
        WHERE tenant_row."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "gateway_billing_events" fact
        WHERE fact."billing_account_id" = manifest.billing_account_id)
      OR EXISTS (SELECT 1 FROM "gateway_billing_events" event_row
        JOIN "api_keys" api_key_row ON api_key_row."id" = event_row."api_key_id"
        JOIN "tenants" tenant_row ON tenant_row."id" = api_key_row."tenant_id"
        WHERE tenant_row."billing_account_id" = manifest.billing_account_id)
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'nprod currency label repair deleted cohort is not inert=%',
      invalid_count USING ERRCODE = '23514';
  END IF;

  IF (SELECT wallet."balance_usd" FROM "account_wallets" wallet
      WHERE wallet."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b')
      IS DISTINCT FROM -0.024176940000::NUMERIC
    OR (SELECT COUNT(*) FROM "balance_transactions" tx
      WHERE tx."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b') <> 562
    OR (SELECT COALESCE(SUM(tx."amount_usd"), 0)
      FROM "balance_transactions" tx WHERE tx."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b')
      IS DISTINCT FROM -0.024176940000::NUMERIC
    OR (SELECT COUNT(*) FROM "balance_grants" grant_row
      WHERE grant_row."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b') <> 1
    OR (SELECT COALESCE(SUM(grant_row."remaining_amount_usd"), 0)
      FROM "balance_grants" grant_row WHERE grant_row."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b') <> 0
    OR (SELECT COUNT(*) FROM "token_usage" usage_row
      JOIN "tenants" tenant_row ON tenant_row."id" = usage_row."tenant_id"
      WHERE tenant_row."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b') <> 561
    OR (SELECT COALESCE(SUM(usage_row."customer_charge_usd"), 0)
      FROM "token_usage" usage_row JOIN "tenants" tenant_row
        ON tenant_row."id" = usage_row."tenant_id"
      WHERE tenant_row."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b')
      IS DISTINCT FROM 5.024176940000::NUMERIC
    OR EXISTS (SELECT 1 FROM "billing_account_credit_configs" credit
      WHERE credit."billing_account_id" =
        'ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b')
  THEN
    RAISE EXCEPTION 'nprod currency label repair negative wallet proof drifted'
      USING ERRCODE = '23514';
  END IF;

  IF (SELECT COUNT(*) FROM "billing_account_credit_configs" credit
      JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
        ON manifest.billing_account_id = credit."billing_account_id") <> 1
    OR NOT EXISTS (
      SELECT 1 FROM "billing_account_credit_configs" credit
      WHERE credit."billing_account_id" =
          '40703476-f6de-4528-8119-11d494bfe2f4'
        AND credit."status" = 'ACTIVE'
        AND credit."limit_usd" = 100.000000000000
        AND credit."policy_revision" = 1
        AND credit."policy_boundary_complete" = TRUE
    )
  THEN
    RAISE EXCEPTION 'nprod currency label repair credit proof drifted'
      USING ERRCODE = '23514';
  END IF;

  -- Eight append-only historical repair rows are not generically terminal.
  -- Seven are APPLIED children of one RUNNING run whose other two children
  -- failed; one FAILED child has one exact later COMPLETED/APPLIED authority.
  -- Bind the entire envelope and reject any additional exception rather than
  -- mutating old audit or trusting only the account's current status label.
  WITH exception_rows AS (
    SELECT source_account."id" AS repair_account_id,
      source_run."id" AS run_id,
      source_account."billing_account_id",
      source_account."status" AS item_status,
      source_run."status" AS run_status,
      source_run."plan_hash", source_run."initiated_by",
      source_run."created_at" AS run_created_at,
      source_run."completed_at" AS run_completed_at,
      source_account."created_at" AS item_created_at,
      source_account."updated_at" AS item_updated_at,
      source_account."precondition_hash", source_account."replay_hash",
      encode(sha256(convert_to(
        source_account."before_snapshot"::TEXT, 'UTF8'
      )), 'hex') AS before_snapshot_hash,
      CASE WHEN source_account."after_snapshot" IS NULL THEN NULL
        ELSE encode(sha256(convert_to(
          source_account."after_snapshot"::TEXT, 'UTF8'
        )), 'hex') END AS after_snapshot_hash,
      source_account."error",
      account_row."balance_grant_ledger_status" AS current_ledger_status,
      account_row."balance_grant_ledger_version" AS current_ledger_version,
      account_row."balance_grant_ledger_hash" AS current_ledger_hash,
      account_row."balance_grant_ledger_reconciled_at"
        AS current_reconciled_at,
      cover.run_id AS covering_run_id,
      cover.run_status AS covering_run_status,
      cover.item_status AS covering_item_status,
      cover.replay_hash AS covering_replay_hash,
      cover.run_created_at AS covering_run_created_at,
      cover.run_completed_at AS covering_run_completed_at,
      cover.item_updated_at AS covering_item_updated_at
    FROM "billing_account_currency_label_ledger_exception_nprod_v2"() expected
    JOIN "balance_ledger_repair_runs" source_run
      ON source_run."id" = expected.repair_run_id
    JOIN "balance_ledger_repair_accounts" source_account
      ON source_account."id" = expected.repair_account_id
      AND source_account."run_id" = source_run."id"
      AND source_account."billing_account_id" = expected.billing_account_id
    JOIN "billing_accounts" account_row
      ON account_row."id" = source_account."billing_account_id"
    LEFT JOIN LATERAL (
      SELECT later_run."id" AS run_id,
        later_run."status" AS run_status,
        later_account."status" AS item_status,
        later_account."replay_hash",
        later_run."created_at" AS run_created_at,
        later_run."completed_at" AS run_completed_at,
        later_account."updated_at" AS item_updated_at
      FROM "balance_ledger_repair_accounts" later_account
      JOIN "balance_ledger_repair_runs" later_run
        ON later_run."id" = later_account."run_id"
      WHERE later_account."billing_account_id"
          = source_account."billing_account_id"
        AND later_run."created_at" > source_run."created_at"
        AND later_run."status" = 'COMPLETED'
        AND later_account."status" = 'APPLIED'
      ORDER BY later_run."created_at" DESC
      LIMIT 1
    ) cover ON TRUE
  )
  SELECT encode(sha256(convert_to(jsonb_agg(
    to_jsonb(exception_rows)
    ORDER BY exception_rows.run_created_at,
      exception_rows.billing_account_id
  )::TEXT, 'UTF8')), 'hex')
  INTO actual_ledger_exception_proof_hash
  FROM exception_rows;

  SELECT COUNT(*) INTO invalid_count
  FROM "balance_ledger_repair_accounts" repair_account
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_account."run_id"
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = repair_account."billing_account_id"
  LEFT JOIN "billing_account_currency_label_ledger_exception_nprod_v2"()
    expected ON expected.repair_account_id = repair_account."id"
      AND expected.repair_run_id = repair_run."id"
      AND expected.billing_account_id = repair_account."billing_account_id"
  WHERE (repair_run."status" IS DISTINCT FROM 'COMPLETED'
      OR repair_account."status" IS DISTINCT FROM 'APPLIED')
    AND expected.repair_account_id IS NULL;
  SELECT COUNT(*) INTO valid_count
  FROM "billing_account_currency_label_ledger_exception_nprod_v2"() expected
  JOIN "balance_ledger_repair_runs" source_run
    ON source_run."id" = expected.repair_run_id
  JOIN "balance_ledger_repair_accounts" source_account
    ON source_account."id" = expected.repair_account_id
    AND source_account."run_id" = source_run."id"
    AND source_account."billing_account_id" = expected.billing_account_id
  JOIN "billing_accounts" account_row
    ON account_row."id" = source_account."billing_account_id"
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = account_row."id"
  LEFT JOIN LATERAL (
    SELECT later_run."id" AS run_id,
      later_run."status" AS run_status,
      later_account."id" AS repair_account_id,
      later_account."status" AS item_status,
      later_account."replay_hash",
      later_account."precondition_hash",
      later_account."after_snapshot"
    FROM "balance_ledger_repair_accounts" later_account
    JOIN "balance_ledger_repair_runs" later_run
      ON later_run."id" = later_account."run_id"
    WHERE later_account."billing_account_id"
        = source_account."billing_account_id"
      AND later_run."created_at" > source_run."created_at"
      AND later_run."status" = 'COMPLETED'
      AND later_account."status" = 'APPLIED'
    ORDER BY later_run."created_at" DESC
    LIMIT 1
  ) cover ON TRUE
  WHERE account_row."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" = 2
    AND account_row."balance_grant_ledger_hash" = manifest.ledger_hash
    AND (
      (expected.authoritative_run_id IS NULL
        AND expected.authoritative_repair_account_id IS NULL
        AND source_run."status" = 'RUNNING'
        AND source_account."status" = 'APPLIED'
        AND source_account."error" IS NULL
        AND source_account."replay_hash"
          = account_row."balance_grant_ledger_hash"
        AND source_account."after_snapshot"->>'ledgerStatus'
          = account_row."balance_grant_ledger_status"
        AND (source_account."after_snapshot"->>'ledgerVersion')::INTEGER
          = account_row."balance_grant_ledger_version"
        AND source_account."after_snapshot"->>'replayHash'
          = account_row."balance_grant_ledger_hash"
        AND source_account."after_snapshot"->>'preconditionHash'
          = source_account."precondition_hash"
        AND ((source_account."after_snapshot"->>'reconciledAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC')
          = account_row."balance_grant_ledger_reconciled_at"
        AND cover.run_id IS NULL
        AND cover.repair_account_id IS NULL)
      OR
      (expected.authoritative_run_id IS NOT NULL
        AND expected.authoritative_repair_account_id IS NOT NULL
        AND source_run."status" = 'COMPLETED_WITH_EXCEPTIONS'
        AND source_account."status" = 'FAILED'
        AND source_account."error" IS NOT NULL
        AND source_account."replay_hash" IS NULL
        AND source_account."after_snapshot" IS NULL
        AND cover.run_id = expected.authoritative_run_id
        AND cover.repair_account_id
          = expected.authoritative_repair_account_id
        AND cover.run_status = 'COMPLETED'
        AND cover.item_status = 'APPLIED'
        AND cover.replay_hash = account_row."balance_grant_ledger_hash"
        AND cover.after_snapshot->>'ledgerStatus'
          = account_row."balance_grant_ledger_status"
        AND (cover.after_snapshot->>'ledgerVersion')::INTEGER
          = account_row."balance_grant_ledger_version"
        AND cover.after_snapshot->>'replayHash'
          = account_row."balance_grant_ledger_hash"
        AND cover.after_snapshot->>'preconditionHash'
          = cover.precondition_hash
        AND ((cover.after_snapshot->>'reconciledAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC')
          = account_row."balance_grant_ledger_reconciled_at")
    );
  IF invalid_count <> 0
    OR valid_count IS DISTINCT FROM expected_ledger_exception_count::BIGINT
    OR actual_ledger_exception_proof_hash
      IS DISTINCT FROM target_ledger_exception_proof_hash
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_ledger_exception_nprod_v2"())
      <> expected_ledger_exception_count
    OR (SELECT COUNT(*) FROM "balance_ledger_repair_accounts" running_account
      WHERE running_account."status" = 'RUNNING'
        AND running_account."billing_account_id" IN (SELECT billing_account_id FROM
          "billing_account_currency_label_manifest_nprod_v2"())) <> 0
    OR (SELECT jsonb_object_agg(repair_status."status", repair_status.row_count)
      FROM (SELECT repair_account."status", COUNT(*) AS row_count
        FROM "balance_ledger_repair_accounts" repair_account
        WHERE repair_account."run_id"
          = 'fd562f5a-e899-4559-932f-3ff916c47c64'
        GROUP BY repair_account."status") repair_status)
      IS DISTINCT FROM '{"APPLIED": 8, "FAILED": 2}'::JSONB
  THEN
    RAISE EXCEPTION 'nprod currency label repair ledger exception proof mismatch extra=% hash=%',
      invalid_count, COALESCE(actual_ledger_exception_proof_hash, 'NULL')
      USING ERRCODE = '23514';
  END IF;

  -- Invoice applications are a financial projection of cohort orders.  The
  -- v1 helper included only line items, so v2 binds and locks the complete
  -- parent/item/event closure and later proves it byte-identical after CAS.
  WITH application_ids AS (
    SELECT DISTINCT invoice_item."application_id"
    FROM "invoice_application_items" invoice_item
    JOIN "orders" order_row ON order_row."id" = invoice_item."order_id"
    JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
      ON manifest.billing_account_id = order_row."billing_account_id"
  )
  SELECT jsonb_build_object(
    'applications', COALESCE((SELECT jsonb_agg(
      to_jsonb(application_row) ORDER BY application_row."id"
    ) FROM "invoice_applications" application_row
      JOIN application_ids ids
        ON ids."application_id" = application_row."id"), '[]'::JSONB),
    'items', COALESCE((SELECT jsonb_agg(
      to_jsonb(item_row) ORDER BY item_row."id"
    ) FROM "invoice_application_items" item_row
      JOIN application_ids ids
        ON ids."application_id" = item_row."application_id"), '[]'::JSONB),
    'events', COALESCE((SELECT jsonb_agg(
      to_jsonb(event_row) ORDER BY event_row."id"
    ) FROM "invoice_event_log" event_row
      JOIN application_ids ids
        ON ids."application_id" = event_row."application_id"), '[]'::JSONB)
  ) INTO invoice_snapshot_before;
  actual_invoice_proof_hash := encode(sha256(convert_to(
    invoice_snapshot_before::TEXT, 'UTF8'
  )), 'hex');
  IF actual_invoice_proof_hash IS DISTINCT FROM target_invoice_proof_hash
    OR jsonb_array_length(invoice_snapshot_before->'applications')
      <> expected_invoice_application_count
    OR jsonb_array_length(invoice_snapshot_before->'items')
      <> expected_invoice_item_count
    OR jsonb_array_length(invoice_snapshot_before->'events')
      <> expected_invoice_event_count
    OR EXISTS (
      SELECT 1
      FROM "invoice_applications" application_row
      WHERE application_row."id" IN (
        SELECT (application_value->>'id')
        FROM jsonb_array_elements(
          invoice_snapshot_before->'applications'
        ) application_value
      )
        AND lower(application_row."currency") IS DISTINCT FROM 'cny'
    )
  THEN
    RAISE EXCEPTION 'nprod currency label repair invoice proof mismatch hash=%',
      COALESCE(actual_invoice_proof_hash, 'NULL') USING ERRCODE = '23514';
  END IF;

  SELECT
    (SELECT COUNT(*) FROM "gateway_usage_settlement_anchors" fact
      JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
        ON manifest.billing_account_id = fact."billing_account_id")
    + (SELECT COUNT(*) FROM "gateway_usage_funding_reservations" fact
      JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
        ON manifest.billing_account_id = fact."billing_account_id")
  INTO invalid_count;
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'nprod currency label repair has frozen currency facts=%',
      invalid_count USING ERRCODE = '23514';
  END IF;

  -- Six PENDING rows are known inert ALIPAY/NOT_STARTED shells.  We bind both
  -- their compact manifest and the complete absence of financial side effects.
  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
    'orderId', order_row."id",
    'billingAccountId', order_row."billing_account_id",
    'orderType', order_row."order_type"::TEXT,
    'amountCents', order_row."amount_cents",
    'currency', order_row."currency",
    'channel', order_row."channel"::TEXT,
    'createdAt', to_char(order_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'),
    'checkoutInitState', order_row."checkout_init_state"::TEXT
  ) ORDER BY order_row."id"), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
  INTO actual_pending_manifest_hash
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  WHERE order_row."status"::TEXT = 'PENDING';

  SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(pending_row)
    ORDER BY pending_row."id")::TEXT, 'UTF8')), 'hex')
  INTO actual_pending_evidence_hash
  FROM (
    SELECT order_row."id", order_row."billing_account_id",
      order_row."order_type"::TEXT AS order_type,
      order_row."amount_cents", order_row."currency",
      order_row."channel"::TEXT AS channel,
      order_row."status"::TEXT AS status,
      to_char(order_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS')
        AS created_at,
      order_row."checkout_init_state"::TEXT AS checkout_init_state,
      order_row."trade_no", order_row."paid_at", order_row."refunded_at",
      order_row."expired_at", order_row."completed_at",
      order_row."cancelled_at", order_row."fulfillment_attempt_id",
      order_row."fulfillment_claimed_at", order_row."checkout_lease_id",
      order_row."checkout_lease_expires_at",
      order_row."checkout_context_encrypted",
      order_row."checkout_provider_reference",
      order_row."checkout_pay_url_encrypted",
      order_row."checkout_pay_url_expires_at",
      (SELECT COUNT(*) FROM "order_audit_logs" fact
        WHERE fact."order_id" = order_row."id") AS audit_count,
      (SELECT COUNT(*) FROM "order_items" fact
        WHERE fact."order_id" = order_row."id") AS item_count,
      (SELECT COUNT(*) FROM "balance_transactions" fact
        WHERE fact."order_id" = order_row."id") AS tx_count,
      (SELECT COUNT(*) FROM "balance_grants" fact
        WHERE fact."order_id" = order_row."id") AS grant_count,
      (SELECT COUNT(*) FROM "stripe_payment_ledgers" fact
        WHERE fact."order_id" = order_row."id") AS stripe_count,
      (SELECT COUNT(*) FROM "provider_refund_intents" fact
        WHERE fact."order_id" = order_row."id") AS refund_count,
      (SELECT COUNT(*) FROM "invoice_application_items" fact
        WHERE fact."order_id" = order_row."id") AS invoice_count
    FROM "orders" order_row
    JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
      ON manifest.billing_account_id = order_row."billing_account_id"
    WHERE order_row."status"::TEXT = 'PENDING'
  ) pending_row;

  SELECT COUNT(*) INTO valid_count
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  WHERE order_row."status"::TEXT = 'PENDING';
  SELECT COUNT(*) INTO invalid_count
  FROM "billing_account_currency_label_pending_order_nprod_v2"() expected
  LEFT JOIN "orders" order_row ON order_row."id" = expected.order_id
  WHERE order_row."id" IS NULL
    OR order_row."billing_account_id"
      IS DISTINCT FROM expected.billing_account_id
    OR order_row."order_type"::TEXT IS DISTINCT FROM expected.order_type
    OR order_row."amount_cents" IS DISTINCT FROM expected.amount_cents
    OR order_row."currency" IS DISTINCT FROM expected.currency
    OR order_row."channel"::TEXT IS DISTINCT FROM expected.channel
    OR order_row."status"::TEXT IS DISTINCT FROM expected.order_status
    OR order_row."created_at" IS DISTINCT FROM expected.created_at
    OR order_row."checkout_init_state"::TEXT
      IS DISTINCT FROM expected.checkout_init_state
    OR order_row."trade_no" IS NOT NULL
    OR order_row."paid_at" IS NOT NULL
    OR order_row."refunded_at" IS NOT NULL
    OR order_row."expired_at" IS NOT NULL
    OR order_row."completed_at" IS NOT NULL
    OR order_row."cancelled_at" IS NOT NULL
    OR order_row."fulfillment_attempt_id" IS NOT NULL
    OR order_row."fulfillment_claimed_at" IS NOT NULL
    OR order_row."checkout_lease_id" IS NOT NULL
    OR order_row."checkout_lease_expires_at" IS NOT NULL
    OR order_row."checkout_context_encrypted" IS NOT NULL
    OR order_row."checkout_provider_reference" IS NOT NULL
    OR order_row."checkout_pay_url_encrypted" IS NOT NULL
    OR order_row."checkout_pay_url_expires_at" IS NOT NULL
    OR EXISTS (SELECT 1 FROM "order_audit_logs" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "order_items" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "balance_transactions" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "balance_grants" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "stripe_payment_ledgers" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "provider_refund_intents" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "refund_compensation_tasks" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "stripe_subscription_cancellation_tasks" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "invoice_application_items" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "coding_plan_provider_entitlements" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "coding_plan_entitlements" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "coding_plan_renewal_charges" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "coding_plan_promo_grants" fact
      WHERE fact."consumed_by_order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "campaign_redemptions" fact
      WHERE fact."order_id" = order_row."id")
    OR EXISTS (SELECT 1 FROM "discount_code_redemptions" fact
      WHERE fact."order_id" = order_row."id");
  IF valid_count IS DISTINCT FROM expected_pending_count::BIGINT
    OR invalid_count <> 0
    OR actual_pending_manifest_hash
      IS DISTINCT FROM target_pending_manifest_hash
    OR actual_pending_evidence_hash
      IS DISTINCT FROM target_pending_evidence_hash
  THEN
    RAISE EXCEPTION 'nprod currency label repair pending evidence mismatch count=% invalid=%',
      valid_count, invalid_count USING ERRCODE = '23514';
  END IF;

  -- Every historical order in the cohort already carries domestic CNY
  -- semantics; no order or amount is rewritten by this label repair.
  SELECT COUNT(*) INTO invalid_count
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  WHERE lower(order_row."currency") <> 'cny'
    OR order_row."status"::TEXT IN (
      'PAID', 'FULFILLING', 'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
      'REFUNDING', 'REFUND_FAILED', 'REFUND_COMPENSATION_FAILED'
    );
  IF invalid_count <> 0
    OR (SELECT jsonb_object_agg(status_rows.status, jsonb_build_object(
      'count', status_rows.row_count, 'amountCents', status_rows.amount_cents
    )) FROM (
      SELECT order_row."status"::TEXT AS status,
        COUNT(*) AS row_count, SUM(order_row."amount_cents") AS amount_cents
      FROM "orders" order_row
      JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
        ON manifest.billing_account_id = order_row."billing_account_id"
      GROUP BY order_row."status"::TEXT
    ) status_rows) IS DISTINCT FROM jsonb_build_object(
      'PENDING', jsonb_build_object('count', 6, 'amountCents', 30300),
      'COMPLETED', jsonb_build_object('count', 55, 'amountCents', 1892098),
      'EXPIRED', jsonb_build_object('count', 126, 'amountCents', 4480336),
      'CANCELLED', jsonb_build_object('count', 12, 'amountCents', 648450),
      'REFUNDED', jsonb_build_object('count', 1, 'amountCents', 52800)
    )
  THEN
    RAISE EXCEPTION 'nprod currency label repair order history drifted'
      USING ERRCODE = '23514';
  END IF;

  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
    'gatewayBillingEventId', event_row."id",
    'requestId', event_row."request_id",
    'eventId', event_row."event_id",
    'evidenceId', evidence_row."id",
    'evidenceHash', event_row."evidence_hash",
    'apiKeyId', event_row."api_key_id",
    'tenantId', event_row."tenant_id",
    'billingAccountId', tenant_row."billing_account_id",
    'evidenceRevision', evidence_row."evidence_revision",
    'evidenceSource', evidence_row."usage_evidence_source",
    'evidenceStatus', evidence_row."usage_evidence_status",
    'evidenceProtocol', evidence_row."usage_evidence_protocol",
    'terminalFrameSeen', evidence_row."terminal_frame_seen",
    'providerReconciliationRequired',
      evidence_row."provider_reconciliation_required",
    'eventCreatedAt', to_char(
      event_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'
    ),
    'evidenceCreatedAt', to_char(
      evidence_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'
    )
  ) ORDER BY event_row."created_at"), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
  INTO actual_event_manifest_hash
  FROM "gateway_billing_events" event_row
  JOIN "gateway_usage_evidences" evidence_row
    ON evidence_row."gateway_billing_event_id" = event_row."id"
  JOIN "api_keys" api_key_row ON api_key_row."id" = event_row."api_key_id"
  JOIN "tenants" tenant_row ON tenant_row."id" = api_key_row."tenant_id"
  WHERE event_row."error_message"
    = 'Gateway billing currency mismatch: account=USD deployment=CNY';

  SELECT COUNT(*) INTO valid_count
  FROM "billing_account_currency_label_event_nprod_v2"() expected
  JOIN "gateway_billing_events" event_row
    ON event_row."id" = expected.gateway_billing_event_id
  JOIN "gateway_usage_evidences" evidence_row
    ON evidence_row."id" = expected.evidence_id
    AND evidence_row."gateway_billing_event_id" = event_row."id"
  JOIN "api_keys" api_key_row
    ON api_key_row."id" = expected.api_key_id
    AND api_key_row."id" = event_row."api_key_id"
  JOIN "tenants" tenant_row
    ON tenant_row."id" = expected.tenant_id
    AND tenant_row."id" = api_key_row."tenant_id"
  WHERE event_row."request_id" = expected.request_id
    AND event_row."event_id" = expected.event_id
    AND event_row."tenant_id" = expected.tenant_id
    AND tenant_row."billing_account_id" = expected.billing_account_id
    AND event_row."billing_account_id" IS NULL
    AND event_row."status" = 'QUARANTINED'
    AND event_row."reason" = 'settlement_anchor_missing'
    AND event_row."error_message"
      = 'Gateway billing currency mismatch: account=USD deployment=CNY'
    AND event_row."evidence_hash" = expected.evidence_hash
    AND event_row."evidence_verdict" = 'INCOMPLETE'
    AND event_row."reconciliation_status" = 'MANUAL_REVIEW'
    AND event_row."funding_outcome" IS NULL
    AND event_row."revision" = 1
    AND event_row."pending_exposure_usd" = 0
    AND event_row."pending_hold_usd" = 0
    AND event_row."created_at" = expected.event_created_at
    AND evidence_row."request_id" = expected.request_id
    AND evidence_row."event_id" = expected.event_id
    AND evidence_row."source" = 'GATEWAY_USAGE_EVENT'
    AND evidence_row."evidence_hash" = expected.evidence_hash
    AND evidence_row."evidence_revision" = expected.evidence_revision
    AND evidence_row."usage_evidence_source" = expected.evidence_source
    AND evidence_row."usage_evidence_status" = expected.evidence_status
    AND evidence_row."usage_evidence_protocol" = expected.evidence_protocol
    AND evidence_row."terminal_frame_seen"
      IS NOT DISTINCT FROM expected.terminal_frame_seen
    AND evidence_row."provider_reconciliation_required"
      IS NOT DISTINCT FROM expected.provider_reconciliation_required
    AND evidence_row."created_at" = expected.evidence_created_at
    AND encode(sha256(convert_to(jsonb_build_object(
      'event', to_jsonb(event_row)
        - 'raw_event' - 'billing_result'
        - 'subject_snapshot' - 'pricing_snapshot',
      'evidence', to_jsonb(evidence_row) - 'raw_evidence',
      'resolvedBillingAccountId', tenant_row."billing_account_id"
    )::TEXT, 'UTF8')), 'hex') = expected.expected_snapshot_hash
    AND NOT EXISTS (SELECT 1 FROM "gateway_usage_settlement_anchors" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "gateway_usage_funding_reservations" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "gateway_usage_settlement_receipts" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "token_usage" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "gateway_usage_reconciliation_actions" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "gateway_usage_platform_losses" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "usage_loss_recognition_claims" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "historical_platform_loss_lines" fact
      WHERE fact."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1 FROM "credit_transactions" fact
      WHERE fact."request_id" = expected.request_id);
  IF valid_count IS DISTINCT FROM expected_event_count::BIGINT
    OR actual_event_manifest_hash IS DISTINCT FROM target_event_manifest_hash
  THEN
    RAISE EXCEPTION 'nprod currency label repair event proof mismatch count=%',
      valid_count USING ERRCODE = '23514';
  END IF;

  -- The two user-facing freezes are part of the pre-state, not incidental
  -- operational data.  Each event must still own its one exact ACTIVE review
  -- restriction and one successfully projected ACTIVE intent, so the later
  -- zero-value ABSORB has a deterministic release edge.
  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
    'gatewayBillingEventId', event_row."id",
    'restrictionId', restriction_row."id",
    'requestId', event_row."request_id",
    'eventApiKeyId', event_row."api_key_id",
    'eventTenantId', event_row."tenant_id",
    'restrictionApiKeyId', restriction_row."api_key_id",
    'restrictionBillingAccountId', restriction_row."billing_account_id",
    'status', restriction_row."status",
    'reason', restriction_row."reason",
    'idempotencyKey', restriction_row."idempotency_key",
    'createdBy', restriction_row."created_by",
    'createdAt', to_char(
      restriction_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'
    ),
    'updatedAt', to_char(
      restriction_row."updated_at", 'YYYY-MM-DD HH24:MI:SS.MS'
    ),
    'intentCount', (SELECT COUNT(*)
      FROM "billing_restriction_projection_intents" intent_row
      WHERE intent_row."billing_access_restriction_id" = restriction_row."id"),
    'succeededIntentCount', (SELECT COUNT(*)
      FROM "billing_restriction_projection_intents" intent_row
      WHERE intent_row."billing_access_restriction_id" = restriction_row."id"
        AND intent_row."status" = 'SUCCEEDED'
        AND intent_row."restriction_status" = 'ACTIVE')
  ) ORDER BY event_row."created_at"), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
  INTO actual_restriction_proof_hash
  FROM "billing_account_currency_label_event_nprod_v2"() expected
  JOIN "gateway_billing_events" event_row
    ON event_row."id" = expected.gateway_billing_event_id
  JOIN "billing_access_restrictions" restriction_row
    ON restriction_row."id" = expected.restriction_id
    AND restriction_row."gateway_billing_event_id" = event_row."id";

  SELECT COUNT(*) INTO valid_count
  FROM "billing_account_currency_label_event_nprod_v2"() expected
  JOIN "gateway_billing_events" event_row
    ON event_row."id" = expected.gateway_billing_event_id
  JOIN "billing_access_restrictions" restriction_row
    ON restriction_row."id" = expected.restriction_id
    AND restriction_row."gateway_billing_event_id" = event_row."id"
  JOIN "billing_restriction_projection_intents" intent_row
    ON intent_row."id" = expected.projection_intent_id
    AND intent_row."billing_access_restriction_id" = restriction_row."id"
  WHERE restriction_row."api_key_id" = expected.api_key_id
    AND restriction_row."billing_account_id" IS NULL
    AND restriction_row."status" = 'ACTIVE'
    AND restriction_row."reason" = 'settlement_policy_review'
    AND restriction_row."idempotency_key"
      = 'gateway:settlement_policy_review:' || expected.request_id
    AND restriction_row."created_by" = 'SYSTEM'
    AND restriction_row."released_by" IS NULL
    AND restriction_row."release_reason" IS NULL
    AND restriction_row."released_at" IS NULL
    AND intent_row."gateway_billing_event_id" = expected.gateway_billing_event_id
    AND intent_row."api_key_id" = expected.api_key_id
    AND intent_row."billing_account_id" IS NULL
    AND intent_row."restriction_status" = 'ACTIVE'
    AND intent_row."status" = 'SUCCEEDED'
    AND intent_row."attempts" = 0
    AND intent_row."locked_at" IS NULL
    AND intent_row."last_error" IS NULL
    AND intent_row."completed_at" IS NOT NULL
    AND (SELECT COUNT(*) FROM "billing_access_restrictions" same_event
      WHERE same_event."gateway_billing_event_id" = event_row."id") = 1
    AND (SELECT COUNT(*) FROM "billing_restriction_projection_intents" same_restriction
      WHERE same_restriction."billing_access_restriction_id"
        = restriction_row."id") = 1;
  IF valid_count IS DISTINCT FROM expected_event_count::BIGINT
    OR actual_restriction_proof_hash
      IS DISTINCT FROM target_restriction_proof_hash
  THEN
    RAISE EXCEPTION 'nprod currency label repair restriction proof mismatch count=% hash=%',
      valid_count, COALESCE(actual_restriction_proof_hash, 'NULL')
      USING ERRCODE = '23514';
  END IF;

  SELECT evidence.evidence_snapshot, evidence.evidence_sha256
  INTO actual_evidence_snapshot, actual_evidence_sha256
  FROM "billing_account_currency_label_evidence_v2"() evidence;
  IF actual_evidence_snapshot IS NULL
    OR actual_evidence_sha256 IS DISTINCT FROM requested_evidence_sha256
  THEN
    RAISE EXCEPTION 'nprod currency label repair evidence mismatch expected=% actual=%',
      requested_evidence_sha256, COALESCE(actual_evidence_sha256, 'NULL')
      USING ERRCODE = '23514';
  END IF;

  operation_run_id := gen_random_uuid()::TEXT;
  operation_at := date_trunc(
    'milliseconds', clock_timestamp() AT TIME ZONE 'UTC'
  );
  INSERT INTO "billing_account_currency_label_repair_runs" (
    "id", "manifest_version", "manifest_hash", "database_name",
    "database_identity", "database_system_identifier", "database_oid",
    "source_currency", "target_currency", "platform_config_snapshot",
    "platform_config_hash", "change_ticket", "operator", "approver_one",
    "approver_two", "evidence_sha256", "confirmation",
    "writers_drained_until", "account_count", "status", "applied_at",
    "created_at"
  ) VALUES (
    operation_run_id, target_manifest_version, target_manifest_hash,
    target_database_name, target_database_identity, target_system_identifier,
    target_database_oid::BIGINT, source_currency, target_currency,
    deployment_config, deployment_config_hash, btrim(requested_change_ticket),
    btrim(requested_operator), btrim(requested_approver_one),
    btrim(requested_approver_two), requested_evidence_sha256,
    requested_confirmation, requested_writers_drained_until,
    expected_account_count, 'APPLIED', operation_at, operation_at
  );

  previous_transition_marker := current_setting(
    'billing.currency_label_repair_run_id', TRUE
  );
  PERFORM set_config(
    'billing.currency_label_repair_run_id', operation_run_id, TRUE
  );

  FOR manifest_row IN
    SELECT manifest.ordinal, manifest.billing_account_id
    FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
    ORDER BY manifest.ordinal
  LOOP
    SELECT to_jsonb(account_row),
      "billing_account_currency_label_financial_snapshot"(account_row."id")
    INTO account_before, financial_before
    FROM "billing_accounts" account_row
    WHERE account_row."id" = manifest_row.billing_account_id
    FOR UPDATE;

    INSERT INTO "billing_account_currency_label_repair_items" (
      "id", "run_id", "billing_account_id", "ordinal",
      "before_currency", "after_currency", "before_account_snapshot",
      "before_account_snapshot_hash", "after_account_snapshot",
      "after_account_snapshot_hash", "financial_snapshot",
      "financial_snapshot_hash", "created_at"
    ) VALUES (
      gen_random_uuid()::TEXT, operation_run_id,
      manifest_row.billing_account_id, manifest_row.ordinal,
      source_currency, target_currency, account_before,
      encode(sha256(convert_to(account_before::TEXT, 'UTF8')), 'hex'),
      jsonb_set(account_before, '{currency}', to_jsonb(target_currency)),
      encode(sha256(convert_to(jsonb_set(
        account_before, '{currency}', to_jsonb(target_currency)
      )::TEXT, 'UTF8')), 'hex'),
      financial_before,
      encode(sha256(convert_to(financial_before::TEXT, 'UTF8')), 'hex'),
      operation_at
    );

    UPDATE "billing_accounts" SET "currency" = target_currency
    WHERE "id" = manifest_row.billing_account_id
      AND "currency" = source_currency;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'nprod currency label repair CAS failed account=%',
        manifest_row.billing_account_id USING ERRCODE = '40001';
    END IF;

    SELECT to_jsonb(account_row),
      "billing_account_currency_label_financial_snapshot"(account_row."id")
    INTO account_after, financial_after
    FROM "billing_accounts" account_row
    WHERE account_row."id" = manifest_row.billing_account_id;
    IF account_after IS DISTINCT FROM jsonb_set(
        account_before, '{currency}', to_jsonb(target_currency)
      ) OR financial_after IS DISTINCT FROM financial_before
    THEN
      RAISE EXCEPTION 'nprod currency label repair changed non-label evidence account=%',
        manifest_row.billing_account_id USING ERRCODE = '23514';
    END IF;
  END LOOP;

  WITH application_ids AS (
    SELECT DISTINCT invoice_item."application_id"
    FROM "invoice_application_items" invoice_item
    JOIN "orders" order_row ON order_row."id" = invoice_item."order_id"
    JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
      ON manifest.billing_account_id = order_row."billing_account_id"
  )
  SELECT jsonb_build_object(
    'applications', COALESCE((SELECT jsonb_agg(
      to_jsonb(application_row) ORDER BY application_row."id"
    ) FROM "invoice_applications" application_row
      JOIN application_ids ids
        ON ids."application_id" = application_row."id"), '[]'::JSONB),
    'items', COALESCE((SELECT jsonb_agg(
      to_jsonb(item_row) ORDER BY item_row."id"
    ) FROM "invoice_application_items" item_row
      JOIN application_ids ids
        ON ids."application_id" = item_row."application_id"), '[]'::JSONB),
    'events', COALESCE((SELECT jsonb_agg(
      to_jsonb(event_row) ORDER BY event_row."id"
    ) FROM "invoice_event_log" event_row
      JOIN application_ids ids
        ON ids."application_id" = event_row."application_id"), '[]'::JSONB)
  ) INTO invoice_snapshot_after;
  IF invoice_snapshot_after IS DISTINCT FROM invoice_snapshot_before THEN
    RAISE EXCEPTION 'nprod currency label repair changed invoice evidence'
      USING ERRCODE = '23514';
  END IF;

  FOR eligible_event_row IN
    SELECT expected.*
    FROM "billing_account_currency_label_event_nprod_v2"() expected
    ORDER BY expected.ordinal
  LOOP
    SELECT jsonb_build_object(
      'event', to_jsonb(event_row)
        - 'raw_event' - 'billing_result'
        - 'subject_snapshot' - 'pricing_snapshot',
      'evidence', to_jsonb(evidence_row) - 'raw_evidence',
      'resolvedBillingAccountId', tenant_row."billing_account_id"
    ) INTO eligible_event_snapshot
    FROM "gateway_billing_events" event_row
    JOIN "gateway_usage_evidences" evidence_row
      ON evidence_row."id" = eligible_event_row.evidence_id
      AND evidence_row."gateway_billing_event_id" = event_row."id"
    JOIN "api_keys" api_key_row
      ON api_key_row."id" = event_row."api_key_id"
    JOIN "tenants" tenant_row
      ON tenant_row."id" = api_key_row."tenant_id"
    WHERE event_row."id" = eligible_event_row.gateway_billing_event_id
      AND event_row."request_id" = eligible_event_row.request_id
      AND event_row."evidence_hash" = eligible_event_row.evidence_hash
      AND tenant_row."billing_account_id"
        = eligible_event_row.billing_account_id;
    IF eligible_event_snapshot IS NULL
      OR encode(sha256(convert_to(
        eligible_event_snapshot::TEXT, 'UTF8'
      )), 'hex') IS DISTINCT FROM eligible_event_row.expected_snapshot_hash
    THEN
      RAISE EXCEPTION 'nprod currency label repair event changed event=%',
        eligible_event_row.gateway_billing_event_id
        USING ERRCODE = '40001';
    END IF;

    eligible_event_row_hash := encode(sha256(convert_to(
      jsonb_build_object(
        'runId', operation_run_id,
        'billingAccountId', eligible_event_row.billing_account_id,
        'gatewayBillingEventId', eligible_event_row.gateway_billing_event_id,
        'requestId', eligible_event_row.request_id,
        'evidenceId', eligible_event_row.evidence_id,
        'evidenceHash', eligible_event_row.evidence_hash,
        'failureCode', 'BILLING_CURRENCY_MIGRATION_REQUIRED',
        'failureReason', 'settlement_anchor_missing',
        'errorMessage',
          'Gateway billing currency mismatch: account=USD deployment=CNY',
        'errorFingerprint',
          'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
        'eventSnapshot', eligible_event_snapshot
      )::TEXT, 'UTF8'
    )), 'hex');

    INSERT INTO "billing_account_currency_label_repair_eligible_events" (
      "id", "run_id", "item_id", "gateway_billing_event_id",
      "request_id", "evidence_id", "evidence_hash", "failure_code",
      "failure_reason", "error_message", "error_fingerprint",
      "event_snapshot", "row_hash", "created_at"
    ) SELECT gen_random_uuid()::TEXT, operation_run_id, item."id",
      eligible_event_row.gateway_billing_event_id,
      eligible_event_row.request_id, eligible_event_row.evidence_id,
      eligible_event_row.evidence_hash,
      'BILLING_CURRENCY_MIGRATION_REQUIRED', 'settlement_anchor_missing',
      'Gateway billing currency mismatch: account=USD deployment=CNY',
      'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
      eligible_event_snapshot, eligible_event_row_hash, operation_at
    FROM "billing_account_currency_label_repair_items" item
    WHERE item."run_id" = operation_run_id
      AND item."billing_account_id" = eligible_event_row.billing_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'nprod currency label event has no account item event=%',
        eligible_event_row.gateway_billing_event_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  PERFORM set_config(
    'billing.currency_label_repair_run_id',
    COALESCE(previous_transition_marker, ''), TRUE
  );

  IF (SELECT COUNT(*)
      FROM "billing_account_currency_label_repair_items" item_count
      WHERE item_count."run_id" = operation_run_id) <> expected_account_count
    OR (SELECT COUNT(*)
      FROM "billing_account_currency_label_repair_eligible_events" event_count
      WHERE event_count."run_id" = operation_run_id) <> expected_event_count
    OR EXISTS (
      SELECT 1
      FROM "billing_account_currency_label_repair_items" item
      JOIN "billing_accounts" account_row
        ON account_row."id" = item."billing_account_id"
      WHERE item."run_id" = operation_run_id
        AND (
          account_row."currency" IS DISTINCT FROM target_currency
          OR to_jsonb(account_row) IS DISTINCT FROM item."after_account_snapshot"
          OR item."after_account_snapshot" IS DISTINCT FROM jsonb_set(
            item."before_account_snapshot", '{currency}',
            to_jsonb(target_currency)
          )
          OR encode(sha256(convert_to(
            "billing_account_currency_label_financial_snapshot"(
              account_row."id"
            )::TEXT, 'UTF8'
          )), 'hex') IS DISTINCT FROM item."financial_snapshot_hash"
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "billing_account_currency_label_repair_eligible_events" eligible
      JOIN "billing_account_currency_label_repair_items" item
        ON item."id" = eligible."item_id"
      WHERE eligible."run_id" = operation_run_id
        AND (
          item."run_id" IS DISTINCT FROM operation_run_id
          OR encode(sha256(convert_to(jsonb_build_object(
            'runId', eligible."run_id",
            'billingAccountId', item."billing_account_id",
            'gatewayBillingEventId', eligible."gateway_billing_event_id",
            'requestId', eligible."request_id",
            'evidenceId', eligible."evidence_id",
            'evidenceHash', eligible."evidence_hash",
            'failureCode', eligible."failure_code",
            'failureReason', eligible."failure_reason",
            'errorMessage', eligible."error_message",
            'errorFingerprint', eligible."error_fingerprint",
            'eventSnapshot', eligible."event_snapshot"
          )::TEXT, 'UTF8')), 'hex') IS DISTINCT FROM eligible."row_hash"
        )
    )
  THEN
    RAISE EXCEPTION 'nprod currency label repair terminal proof failed'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT operation_run_id, target_manifest_version,
    'APPLIED'::TEXT, expected_account_count, operation_at;
END
$$;

-- The authority is owner-only.  Runtime receives SELECT on the existing audit
-- tables from 00100; no runtime role can execute manifests, evidence or apply.
REVOKE ALL ON FUNCTION
  "apply_legacy_billing_account_currency_label_repair_v2"(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP(3)
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_manifest_nprod_v2"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "billing_account_currency_label_deleted_member_nprod_v2"() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "billing_account_currency_label_ledger_exception_nprod_v2"() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "billing_account_currency_label_pending_order_nprod_v2"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_event_nprod_v2"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_evidence_v2"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "enforce_billing_account_currency_immutability"()
  FROM PUBLIC;

COMMENT ON FUNCTION
  "apply_legacy_billing_account_currency_label_repair_v2"(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP(3)
  ) IS
  'Owner-only, drained, database-bound label repair for the fixed Beijing nprod 71-account USD manifest. It changes no monetary value.';

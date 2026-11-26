# 海外 Invoice 模板

个人 / 企业共用一份模板，填表时不要改 seller / logo / 银行区。

- 文件：`Invoice模板.xlsx`
- seller = iSoftStone Information Technology Hong Kong Limited
- Bill To：B 列标签，C 列取值（C12 title / C13 email / C14 recipientAddress）
- 明细从第 19 行起按实际产品写入，SN 从 1 递增；只有一项时删除空行
- Description 按产品写 `Raytone API` / `Token Plan`，不是行位写死
- G 列 REMARK 填订单 `orderId`（多订单逗号拼接）
- H5 发票号留空，由 PSA 开票后回填
- 合计公式按行数写成 `SUM(F19:F{lastLine})`

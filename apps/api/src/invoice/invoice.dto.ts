import { z } from 'zod';

const InvoiceProfileKindSchema = z.enum(['PERSONAL', 'ENTERPRISE']);
const InvoiceTypeSchema = z.enum(['VAT_NORMAL', 'VAT_SPECIAL', 'COMMERCIAL_HK']);
const InvoiceLineDescriptionSchema = z.enum(['RAYTONE_API', 'TOKEN_PLAN']);
const InvoiceApplicationStatusSchema = z.enum([
  'PENDING_REVIEW',
  'APPROVED_ISSUING',
  'ISSUED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
  'VOIDED',
  'RED_OFFSET',
]);

export const createProfileDtoSchema = z.object({
  kind: InvoiceProfileKindSchema,
  invoiceType: InvoiceTypeSchema,
  title: z.string().min(1).max(200),
  taxNo: z.string().max(64).optional().nullable(),
  bankName: z.string().max(120).optional().nullable(),
  bankAccount: z.string().max(64).optional().nullable(),
  registeredAddress: z.string().max(400).optional().nullable(),
  registeredPhone: z.string().max(40).optional().nullable(),
  recipientName: z.string().max(80).optional().nullable(),
  recipientEmail: z.string().email().max(120).optional().nullable(),
  recipientPhone: z.string().max(40).optional().nullable(),
  recipientAddress: z.string().max(400).optional().nullable(),
  isDefault: z.boolean().optional(),
});
export type CreateProfileDto = z.infer<typeof createProfileDtoSchema>;

export const updateProfileDtoSchema = createProfileDtoSchema.partial();
export type UpdateProfileDto = z.infer<typeof updateProfileDtoSchema>;

const submitItemSchema = z.object({
  orderId: z.string().min(1),
  description: InvoiceLineDescriptionSchema.optional(),
  poNumber: z.string().max(120).optional().nullable(),
  serviceStart: z.coerce.date().optional().nullable(),
  serviceEnd: z.coerce.date().optional().nullable(),
});

export const submitApplicationDtoSchema = z.object({
  profileId: z.string().min(1),
  items: z.array(submitItemSchema).min(1).max(20),
  idempotencyKey: z.string().min(8).max(120),
});
export type SubmitApplicationDto = z.infer<typeof submitApplicationDtoSchema>;

export const listInvoiceablePeriodsQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  description: InvoiceLineDescriptionSchema.optional(),
});
export type ListInvoiceablePeriodsQuery = z.infer<typeof listInvoiceablePeriodsQuerySchema>;

export const submitPeriodApplicationDtoSchema = z.object({
  profileId: z.string().min(1),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period 必须是 YYYY-MM 格式'),
  idempotencyKey: z.string().min(8).max(120),
  description: InvoiceLineDescriptionSchema.optional(),
  poNumber: z.string().max(120).optional().nullable(),
});
export type SubmitPeriodApplicationDto = z.infer<typeof submitPeriodApplicationDtoSchema>;

export const listApplicationsQuerySchema = z.object({
  status: InvoiceApplicationStatusSchema.optional(),
  description: InvoiceLineDescriptionSchema.optional(),
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
});
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;

export const adminListApplicationsQuerySchema = listApplicationsQuerySchema.extend({
  status: InvoiceApplicationStatusSchema.optional(),
  userId: z.string().optional(),
  tenantId: z.string().optional(),
  email: z.string().max(200).optional(),
  username: z.string().max(200).optional(),
  orderId: z.string().max(120).optional(),
  productName: z.string().max(200).optional(),
  applicationNo: z.string().max(64).optional(),
  invoiceNumber: z.string().max(64).optional(),
  issuedFrom: z.coerce.date().optional(),
  issuedTo: z.coerce.date().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50).optional(),
});
export type AdminListApplicationsQuery = z.infer<typeof adminListApplicationsQuerySchema>;

export const adminDownloadInvoicesDtoSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});
export type AdminDownloadInvoicesDto = z.infer<typeof adminDownloadInvoicesDtoSchema>;

export const approveApplicationDtoSchema = z.object({
  remark: z.string().max(500).optional().nullable(),
});
export type ApproveApplicationDto = z.infer<typeof approveApplicationDtoSchema>;

export const rejectApplicationDtoSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RejectApplicationDto = z.infer<typeof rejectApplicationDtoSchema>;

const uploadedInvoiceFileSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(120).optional().nullable(),
  base64: z.string().min(1).max(8_000_000),
});

export const issueUploadedApplicationDtoSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(64),
  issuingEntity: z.string().min(1).max(64),
  issueDate: z.coerce.date(),
  taxAmountCents: z.coerce.number().int().min(0).optional().nullable(),
  itemId: z.string().min(1).optional(),
  pdfFile: uploadedInvoiceFileSchema,
  ofdFile: uploadedInvoiceFileSchema.optional().nullable(),
});
export type IssueUploadedApplicationDto = z.infer<typeof issueUploadedApplicationDtoSchema>;

export const voidOrRedOffsetDtoSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type VoidOrRedOffsetDto = z.infer<typeof voidOrRedOffsetDtoSchema>;

export const repairInternationalRechargeInvoicesDtoSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  applicationIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});
export type RepairInternationalRechargeInvoicesDto = z.infer<
  typeof repairInternationalRechargeInvoicesDtoSchema
>;

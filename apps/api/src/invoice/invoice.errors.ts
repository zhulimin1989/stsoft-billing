import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

export class InvoiceProfileNotFoundError extends NotFoundException {
  constructor() {
    super({ code: 40410, message: '开票抬头不存在或已删除' });
  }
}

export class InvoiceOrderNotFoundError extends NotFoundException {
  constructor() {
    super({ code: 40411, message: '订单不存在或不属于当前用户' });
  }
}

export class InvoiceApplicationNotFoundError extends NotFoundException {
  constructor() {
    super({ code: 40412, message: '发票申请不存在' });
  }
}

export class InvoiceNothingToInvoiceError extends BadRequestException {
  constructor(orderId?: string) {
    super({
      code: 40010,
      message: orderId
        ? `订单 ${orderId} 没有可开票金额（未满足开票条件或已被占用）`
        : '没有可开票金额（未满足开票条件或已被占用）',
    });
  }
}

export class InvoiceCurrencyMismatchError extends BadRequestException {
  constructor() {
    super({ code: 40011, message: '一张发票只能包含同一币种的订单' });
  }
}

export class InvoiceInvalidStateTransitionError extends BadRequestException {
  constructor(from: string, to: string) {
    super({ code: 40012, message: `发票状态不能从 ${from} 切换到 ${to}` });
  }
}

export class InvoiceMissingIssueDataError extends BadRequestException {
  constructor() {
    super({ code: 40013, message: '开票需要提供 issuingEntity / issueDate / pdfUrl' });
  }
}

export class InvoiceInvalidUploadedFileError extends BadRequestException {
  constructor(message = '上传票据文件格式不正确') {
    super({ code: 40014, message });
  }
}

export class InvoiceDeploymentMismatchError extends BadRequestException {
  constructor(message: string) {
    super({ code: 40015, message });
  }
}

export class InvoiceAccessDeniedError extends ForbiddenException {
  constructor() {
    super({ code: 40310, message: '无权访问该发票申请' });
  }
}

export class InvoiceNumberAlreadyUsedError extends ConflictException {
  constructor(invoiceNumber: string, usedBy?: { applicationNo: string; status: string }) {
    super({
      code: 40910,
      message: usedBy
        ? `发票号码 ${invoiceNumber} 已被使用（${usedBy.applicationNo}，当前状态 ${usedBy.status}），请更换号码`
        : `发票号码 ${invoiceNumber} 已被使用，请更换号码`,
    });
  }
}

export class InvoicePsaRetryNotAllowedError extends BadRequestException {
  constructor(message = '当前 PSA 状态不可重试') {
    super({ code: 40016, message });
  }
}

export class InvoicePsaNotEnabledError extends BadRequestException {
  constructor() {
    super({ code: 40017, message: 'PSA 开票未启用' });
  }
}

export class InvoicePsaAttachmentNotFoundError extends NotFoundException {
  constructor() {
    super({ code: 40431, message: '海外 Invoice 文件尚未生成' });
  }
}

export class InvoiceItemNotFoundError extends NotFoundException {
  constructor() {
    super({ code: 40413, message: '发票申请明细不存在' });
  }
}

export class InvoiceItemUploadRequiredError extends BadRequestException {
  constructor() {
    super({ code: 40018, message: '多订单申请请按订单分别上传发票' });
  }
}

export class InvoiceItemAlreadyIssuedError extends BadRequestException {
  constructor() {
    super({ code: 40019, message: '该订单已上传发票' });
  }
}


import { Module } from '@nestjs/common';
import { BillingHttpModule } from '../billing/billing-core.module';
import { BillingInternalGuard } from '../billing-runtime/billing-internal.guard';
import { ObjectStoreFactory } from '../object-store/object-store.factory';
import { InvoiceAdminController } from './invoice-admin.controller';
import { InvoiceApplicationService } from './invoice-application.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceDeploymentService } from './invoice-deployment.service';
import { InvoiceDomesticService } from './invoice-domestic.service';
import { InvoiceEventService } from './invoice-event.service';
import { InvoiceInternationalService } from './invoice-international.service';
import { InvoiceStorageService } from './invoice-storage.service';
import { InvoiceProfileService } from './invoice-profile.service';
import { InvoiceSourceService } from './invoice-source.service';
import { InvoiceService } from './invoice.service';
import { PsaInvoiceClient } from './psa-invoice.client';
import { OverseasInvoiceTemplateService } from './overseas-invoice-template.service';
import {
  DomesticInvoiceWorkflow,
  InternationalInvoiceWorkflow,
  InvoiceWorkflowRegistry,
} from './invoice-workflow.registry';

@Module({
  imports: [BillingHttpModule],
  controllers: [InvoiceController, InvoiceAdminController],
  providers: [
    InvoiceService,
    InvoiceApplicationService,
    InvoiceInternationalService,
    InvoiceDomesticService,
    InvoiceDeploymentService,
    DomesticInvoiceWorkflow,
    InternationalInvoiceWorkflow,
    InvoiceWorkflowRegistry,
    InvoiceProfileService,
    InvoiceEventService,
    InvoiceStorageService,
    ObjectStoreFactory,
    InvoiceSourceService,
    BillingInternalGuard,
    PsaInvoiceClient,
    OverseasInvoiceTemplateService,
  ],
  exports: [
    InvoiceService,
    InvoiceApplicationService,
    InvoiceInternationalService,
    InvoiceDomesticService,
    InvoiceDeploymentService,
    DomesticInvoiceWorkflow,
    InternationalInvoiceWorkflow,
    InvoiceWorkflowRegistry,
    InvoiceProfileService,
    InvoiceEventService,
    InvoiceStorageService,
    ObjectStoreFactory,
    InvoiceSourceService,
    PsaInvoiceClient,
    OverseasInvoiceTemplateService,
  ],
})
export class InvoiceModule {}

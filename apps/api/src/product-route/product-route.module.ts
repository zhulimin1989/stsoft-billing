import { Module } from '@nestjs/common';
import { PublisherModule } from '../publisher/publisher.module';
import { ProductRouteService } from './product-route.service';

@Module({
  imports: [PublisherModule],
  providers: [ProductRouteService],
  exports: [ProductRouteService],
})
export class ProductRouteModule {}

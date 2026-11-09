import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
    }),
  );

  // Swagger Documentation Setup
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Dhan Trader Backend API')
    .setDescription(
      'High-performance algorithmic trading and price alert engine powered by Dhan HQ API v2 and NestJS (TypeScript).',
    )
    .setVersion('2.0.0')
    .addTag('System', 'Service status & health')
    .addTag('Auth', 'Dhan access token inspection, validation and renewal')
    .addTag('Alerts', 'Price alerts monitoring on NSE Indices')
    .addTag('Orders', 'Order placement, book inspection, and cancellation')
    .addTag('Trades', 'Historical trade book, financial year reporting, and turnover analytics')
    .addTag('Instruments', 'NSE scrip master search and indices lookup')
    .addTag('Telegram', 'Telegram bot alerts and live connection configuration')
    .addTag('Firestore', 'Google Cloud Firestore database connection and operations')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);
  SwaggerModule.setup('swagger', app, document);

  // Serve raw openapi.json for UI generators
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/api/docs/openapi.json', (req: any, res: any) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(document);
  });

  const configService = app.get(ConfigService);
  const port = Number(process.env.PORT) || configService.port || 8000;
  const host = process.env.HOST || configService.host || '127.0.0.1';

  await app.listen(port, host);

  console.log(`====================================================`);
  console.log(`🚀 Dhan Trader Backend API active on http://${host}:${port}`);
  console.log(`🛠️ Framework: NestJS (TypeScript)`);
  console.log(`📖 Swagger API Docs: http://${host}:${port}/docs`);
  console.log(`📄 OpenAPI Spec: http://${host}:${port}/api/docs/openapi.json`);
  console.log(`====================================================`);
}

bootstrap();

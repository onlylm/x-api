import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/database.js';
import { MockPaymentClient } from '../src/clients/payment.js';
import { MockZovoClient } from '../src/clients/zovo.js';
import { MockXApiClient } from '../src/clients/x-api.js';
import { OrderService } from '../src/services/order-service.js';
import { ActivationService } from '../src/services/activation-service.js';
import { ledgerTestConfig } from './ledger-fixtures.js';

let directory: string, gate: string, db: AppDatabase, orders: OrderService,
  payment: MockPaymentClient, x: MockXApiClient, activation: ActivationService;
const input = (key='GATE-ORDER-001') => ({product:'x_premium_3m',quantity:1,sellPrice:'30.00',clientOrderId:key,recipient:'@example_user'});
beforeEach(() => {
  directory=mkdtempSync(join(tmpdir(),'x-gate-'));
  gate=join(directory,'sales.enabled');
  const config=ledgerTestConfig(join(directory,'test.sqlite'));
  db=new AppDatabase(config.databasePath);
  db.seedProducts([{product:'x_premium_3m',plan:'x_premium_3m',name:'X Premium',name_zh:'蓝V3个月',
    cost_price:'22.00',internal_cost_cny:'0.00',max_sell_price:'9999.00',currency:'CNY',max_qty:1,enabled:true}]);
  payment=new MockPaymentClient(config.publicBaseUrl);x=new MockXApiClient();
  orders=new OrderService(db,payment,new MockZovoClient(),x,{
    encryptionKey:config.sessionEncryptionKey,hmacKey:config.emailHmacKey,
  },gate);
  activation=new ActivationService(config,db);
});
afterEach(()=>{db.close();rmSync(directory,{recursive:true,force:true});vi.restoreAllMocks();});

it('closed gate hides availability and refuses a new payment without an intent',async()=>{
  const create=vi.spyOn(payment,'createPaymentUrl');
  expect((await orders.getProducts())[0].in_stock).toBe(false);
  await expect(orders.createOrder(input())).rejects.toMatchObject({code:'sales_paused'});
  expect(create).not.toHaveBeenCalled();
  expect(db.db.prepare('SELECT COUNT(*) n FROM checkout_intents').get()?.n).toBe(0);
});
it('pause preserves original order replay without creating another payment',async()=>{
  writeFileSync(gate,'enabled');
  const create=vi.spyOn(payment,'createPaymentUrl');
  const first=await orders.createOrder(input());
  rmSync(gate);
  const replay=await orders.createOrder(input());
  expect(replay.order.order_id).toBe(first.order.order_id);expect(replay.idempotent).toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
  await expect(orders.createOrder(input('GATE-ORDER-002'))).rejects.toMatchObject({code:'sales_paused'});
});
it('checks the gate again after recipient verification and before creating payment',async()=>{
  writeFileSync(gate,'enabled');
  const real=x.eligibility.bind(x);
  vi.spyOn(x,'eligibility').mockImplementation(async username=>{const result=await real(username);rmSync(gate);return result;});
  const create=vi.spyOn(payment,'createPaymentUrl');
  await expect(orders.createOrder(input())).rejects.toMatchObject({code:'sales_paused'});
  expect(create).not.toHaveBeenCalled();
});
it('already paid orders still enter fulfillment while the sales gate is closed',async()=>{
  writeFileSync(gate,'enabled');
  const {order}=await orders.createOrder(input());rmSync(gate);
  db.markOrderPaid(order.order_id,new Date().toISOString(),'trade-001','30.00');
  const first=activation.createForPaidOrder(order.order_id)!;
  expect(first.finished).toBe(0);
  expect(activation.createForPaidOrder(order.order_id)?.task_id).toBe(first.task_id);
  expect(db.listActivations(order.order_id)).toHaveLength(1);
});

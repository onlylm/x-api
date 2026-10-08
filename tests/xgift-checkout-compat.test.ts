import test from 'node:test'
import assert from 'node:assert/strict'
import { validatedCheckoutUrl } from '../services/xgift/server/native-executor.ts'
import { safePaymentPage } from '../services/xgift/web/order-ui.ts'

const session = 'cs_live_fixtureCompat123'
test('server and frontend accept exact c/pay, g/pay and legacy pay paths with original fragments', () => {
  for (const prefix of ['c/', 'g/', '']) for (const suffix of ['', '#original-fragment', '?locale=en#original-fragment']) {
    const url = 'https://checkout.stripe.com/' + prefix + 'pay/' + session + suffix
    assert.equal(validatedCheckoutUrl(url, session), url)
    assert.equal(safePaymentPage(url), url)
  }
})

test('g/pay compatibility does not broaden hosts, protocols, credentials, ports or arbitrary paths', () => {
  for (const url of [
    'http://checkout.stripe.com/g/pay/' + session,
    'https://checkout.stripe.com.evil.test/g/pay/' + session,
    'https://evil.test/g/pay/' + session,
    'https://user:password@checkout.stripe.com/g/pay/' + session,
    'https://checkout.stripe.com:444/g/pay/' + session,
    'https://checkout.stripe.com/g/pay/cs_test_fixture',
    'https://checkout.stripe.com/g/pay/' + session + '/extra',
    'https://checkout.stripe.com/g/pay/%63s_live_fixtureCompat123',
    'https://checkout.stripe.com/g/pay/' + session + '/',
    'https://checkout.stripe.com/g/other/' + session,
    'https://checkout.stripe.com/x/pay/' + session,
  ]) {
    assert.throws(() => validatedCheckoutUrl(url, session))
    assert.equal(safePaymentPage(url), null)
  }
  assert.throws(() => validatedCheckoutUrl('https://checkout.stripe.com/g/pay/cs_live_other', session))
})

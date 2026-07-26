'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { finalizeReply } = require('../src/services/ai/final-reply-pipeline');
const { stripAvoidedContent } = require('../lib/post-process-reply');

test('20 concurrent merchants keep prices, forbidden phrases, tone, and employee identity isolated', async () => {
  const merchants = Array.from({ length: 20 }, (_, index) => ({
    tenantId: `tenant-${index}`,
    price: 180 + index,
    forbidden: `FORBIDDEN_${index}`,
    employee: `EMPLOYEE_${index}`,
    config: {
      productCatalogVersion: index + 1,
      products: [{
        id: `adobe-${index}`,
        name: 'أدوبي',
        aliases: ['Adobe'],
        available: true,
        variants: [{
          id: `four-months-${index}`,
          label: 'اشتراك 4 أشهر',
          duration: '4 أشهر',
          price: 180 + index,
          currency: 'SAR',
          available: true,
        }],
      }],
      replyStyle: {
        avoidWords: [`FORBIDDEN_${index}`],
        avoidPhrases: [],
        employeeNameEnabled: false,
        employeeName: `EMPLOYEE_${index}`,
      },
    },
  }));

  const results = await Promise.all(merchants.map(async merchant => {
    await new Promise(resolve => setImmediate(resolve));
    const draft = `أدوبي 4 أشهر بـ${merchant.price} ريال ${merchant.forbidden} معك ${merchant.employee}`;
    const cleaned = stripAvoidedContent(draft, merchant.config);
    return finalizeReply({
      draft: cleaned,
      customerText: 'كم أدوبي 4 أشهر؟',
      history: [{ role: 'user', content: 'كم أدوبي 4 أشهر؟' }],
      config: merchant.config,
    });
  }));

  for (let index = 0; index < merchants.length; index++) {
    const result = results[index];
    assert.equal(result.decision, 'validated');
    assert.match(result.reply, new RegExp(String(merchants[index].price)));
    assert.doesNotMatch(result.reply, new RegExp(merchants[index].forbidden));
    assert.doesNotMatch(result.reply, new RegExp(merchants[index].employee));
    for (let other = 0; other < merchants.length; other++) {
      if (other === index) continue;
      assert.doesNotMatch(result.reply, new RegExp(`\\b${merchants[other].price}\\b`));
      assert.doesNotMatch(result.reply, new RegExp(merchants[other].forbidden));
      assert.doesNotMatch(result.reply, new RegExp(merchants[other].employee));
    }
  }
});

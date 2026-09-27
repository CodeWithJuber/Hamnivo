import { describe, expect, it } from 'vitest';
import { checkCompletionClaims, findCompletionClaims } from '../../src/commerce/index.js';

const PAYMENT_CLAIMS = [
  'Your payment has been confirmed.',
  'Good news: the payment was successful!',
  'Your payment is now complete and your order is on its way.',
  'Payment received — thank you.',
  'Your order has been paid in full.',
  "You've paid AED 60.00.",
  'We have received your payment.',
  'Payment confirmed. We will prepare your order soon.',
  'The transaction was approved.',
  'Aapka payment ho gaya hai, order jaldi ship hoga.',
  'Payment successfully receive ho gaya.',
  'Paise mil gaye? Nahi, paisa mil gaya hai.',
  'आपका भुगतान हो गया है।',
  'पेमेंट सफलतापूर्वक प्राप्त हो गया।',
  'भुगतान सफल रहा।',
  'آپ کی ادائیگی ہو گئی ہے۔',
  'ادائیگی کامیابی سے موصول ہو گئی۔',
  'تم الدفع بنجاح.',
  'تم استلام الدفعة، شكراً لك.',
  'الدفع ناجح.',
];

const REFUND_CLAIMS = [
  'Your refund has been issued.',
  'The refund of AED 15.00 was processed.',
  "I've refunded the pen set.",
  'We have issued a refund for the pen set.',
  'The order has been fully refunded.',
  'Refund confirmed · AED 15.00',
  'Refund ho gaya hai, 5 din mein account mein dikhega.',
  'Maine refund kar diya hai.',
  'Paise wapas aa gaye hain.',
  'आपका रिफंड हो गया है।',
  'रिफंड जारी कर दिया गया है।',
  'آپ کا ریفنڈ ہو گیا ہے۔',
  'رقم واپس کر دی گئی ہے۔',
  'تم استرداد المبلغ.',
  'تم إصدار الاسترداد بنجاح.',
];

/** Honest statements about pending, future, negated, conditional or asked-about outcomes. */
const NOT_CLAIMS = [
  "We're waiting for confirmation from the payment service.",
  'Your payment confirmation is still pending. Please don’t place the same order again yet.',
  'Your payment has not been confirmed yet.',
  'The payment was not completed.',
  'Once your payment is confirmed, we will prepare your order.',
  'When the refund is processed you will see it in 5 to 10 days.',
  'If your payment was successful, you will get an email.',
  'Has your payment been confirmed?',
  'Was the payment successful?',
  'I have requested a refund for the pen set; a support lead needs to approve it.',
  'Your refund is awaiting approval.',
  'The refund will be issued after approval.',
  'Refund request submitted. No confirmed refund yet.',
  'Mujhe abhi payment confirmation nahi mili. Status check kar raha hoon.',
  'Agar payment ho gaya hai to order ship hoga.',
  'Kya payment ho gaya?',
  'Refund approve hone ke baad paisa wapas mil jayega.',
  'भुगतान की पुष्टि अभी नहीं हुई है।',
  'क्या भुगतान हो गया?',
  'ادائیگی کی تصدیق ابھی نہیں ہوئی۔',
  'اگر آپ کی ادائیگی ہو گئی ہے تو ہم آرڈر بھیج دیں گے۔',
  'لم يتم تأكيد الدفع بعد.',
  'هل تم الدفع؟',
  'بمجرد تم الدفع سنقوم بتجهيز طلبك.',
  'Please continue to the secure checkout page to pay.',
  'The total is AED 60.00, including delivery.',
];

describe('completion claims (X10)', () => {
  it.each(PAYMENT_CLAIMS)('finds a payment claim: %s', (text) => {
    expect(findCompletionClaims(text).map((f) => f.claim)).toContain('payment_completed');
  });

  it.each(REFUND_CLAIMS)('finds a refund claim: %s', (text) => {
    expect(findCompletionClaims(text).map((f) => f.claim)).toContain('refund_completed');
  });

  it.each(NOT_CLAIMS)('does not treat this as a claim: %s', (text) => {
    expect(findCompletionClaims(text)).toEqual([]);
  });

  it('passes a claim only with the matching receipt', () => {
    const text = 'Your payment has been confirmed and your refund has been issued.';
    expect(
      checkCompletionClaims(text, { paymentConfirmed: false, refundConfirmed: false }),
    ).toEqual({
      ok: false,
      unsupported: [
        { claim: 'payment_completed', rule: 'en.payment_done' },
        { claim: 'refund_completed', rule: 'en.refund_done' },
      ],
    });
    expect(checkCompletionClaims(text, { paymentConfirmed: true, refundConfirmed: false })).toEqual(
      {
        ok: false,
        unsupported: [{ claim: 'refund_completed', rule: 'en.refund_done' }],
      },
    );
    expect(checkCompletionClaims(text, { paymentConfirmed: true, refundConfirmed: true })).toEqual({
      ok: true,
    });
    expect(
      checkCompletionClaims('We are checking the status.', {
        paymentConfirmed: false,
        refundConfirmed: false,
      }),
    ).toEqual({ ok: true });
  });
});

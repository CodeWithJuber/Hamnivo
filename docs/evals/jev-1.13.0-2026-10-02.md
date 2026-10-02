# jev-1.13.0 on Hamnivo's decisions (2026-10-02)

Provider `jev`, model `jev-1.13.0` (pinned), through `@hamnivo/adapters/jev`, with the questions the product asks. 381 messages, 381 calls (4 at a time, 5 s deadline per call), 256,437 input tokens, about $0.0108 at $0.042 per million input tokens (output is free).

Command: `pnpm --filter @hamnivo/evals run-suite decisions --provider jev --model jev-1.13.0 --max-calls 2000 --concurrency 4`

The answers are stored in `docs/evals/jev-1.13.0-2026-10-02.answers.json` (corpus ids and numbers, no text): `run-suite decisions --from docs/evals/jev-1.13.0-2026-10-02.answers.json` scores them again without calling anyone.

Every call was answered.

## Summary

- **Routing:** Jev chose the right topic for 0.977 (260/266) of the messages; the fixed keyword rule managed 0.707 (188/266). Brier 0.034, calibration error 0.014.
- **Request for a person:** 0.987 (376/381) right at 0.5 (Brier 0.013); the fixed rule, which decides first, was right for 1.000 (381/381) (its own test cases are part of the set). Jev only adds a hand-off from 0.80 up; its errors are listed below.
- **Language:** 0.868 (243/280); Hinglish and Roman Urdu as one: 0.989 (89/90). Jev’s Hinglish answer is not reliable enough to act on, so the product keeps asking the customer once when Latin-script Hindustani is ambiguous.
- **Speed and cost:** p50 148 ms, p95 214 ms; 0 of 381 calls took longer than the 1.5 s chat deadline. About 673 input tokens per call, $0.0000283 per decision.
- **U13 pairs:** 12 of 12 groups got the same answer for every variant.

One run, about 40 messages per slice: enough to set starting thresholds and to see where Jev is weak, not to rank slices that differ by a few points. Thresholds hold only for `jev-1.13.0` and these questions; a new Jev version needs a new run.

## What was measured

- **Request for a person** (`wants_person`, a noul): does the customer ask for a human? In the product a fixed rule decides first and always wins; Jev can only add a hand-off.
- **Routing intent** (`intent`, a choice over the brand’s topics plus `other`): the team-routing question (J02).
- **Language** (`language`, a choice over the six language slices): U01.

Each message is one call with all three questions (Jev answers them in parallel, independently). The state is what routing sends: `{"messages": [<the message, personal data replaced by its kind>], "conversation": "with_ai"}`.

```json
{
  "wants_person": {
    "type": "noul",
    "instructions": "Is the customer asking to talk to a human person (a member of staff) instead of the AI assistant?",
    "outcomes": {
      "true": "The customer asks for a person, a human, an agent or a member of staff",
      "false": "The customer does not ask for a person"
    }
  },
  "intent": {
    "type": "choice",
    "instructions": "Which of these topics is the customer asking about? Choose \"other\" when none fits or the messages do not say.",
    "labels": {
      "billing": "Payments, charges, invoices and refunds",
      "shipping": "Delivery, parcels, tracking and delivery delays",
      "returns": "Returning or exchanging an item",
      "account": "Signing in, passwords, account details and account settings",
      "product": "Questions about products before buying: sizes, colours, stock and features",
      "other": "None of these, or not clear from the messages"
    }
  },
  "language": {
    "type": "choice",
    "instructions": "In which language are the customer's messages written?",
    "labels": {
      "en": "English",
      "ar": "Arabic, in Arabic script",
      "hi": "Hindi, in Devanagari script",
      "ur": "Urdu, in Urdu (Arabic) script",
      "hinglish": "Hindi written in Latin letters (Hinglish), often mixed with English words",
      "roman-urdu": "Urdu written in Latin letters (Roman Urdu), often mixed with English words"
    }
  }
}
```

## Corpora

- Routing corpus (`packages/evals/corpus/decisions-routing.json`, written for this evaluation): 240
- Hand-off fixtures (`packages/domain/test/fixtures/human-requests.json`): 101
- U13 pairs (`packages/evals/corpus/fairness.json`, routing and hand-off groups): 40

Non-English text is pending review by native speakers. The routing corpus was written for this evaluation, not taken from customers. Some Hinglish and Roman Urdu messages read the same in both; they are kept, because the product has to handle that ambiguity (it asks the customer once).

## Results

"Accuracy" is the provider’s top answer (a noul at 0.5); "fixed rule" is the product’s deterministic rule on the same messages, which decides whenever Jev abstains. Rates show the 95% Wilson interval in the JSON results; with about 40 messages per slice, differences of a few points are not meaningful. Brier: lower is better (0 is perfect). Calibration error: expected calibration error over 10 bins.

### Request for a person

| Slice | Messages (asking) | Accuracy | Fixed rule | Brier | Calibration error | Band | Abstained | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| English | 79 (19) | 0.987 (78/79) | 1.000 (79/79) | 0.010 | 0.042 | ≥ 0.80 / ≤ 0.50 | 3% | 1.000 | 0.947 |
| Hinglish | 60 (11) | 1.000 (60/60) | 1.000 (60/60) | 0.017 | 0.066 | ≥ 0.80 / ≤ 0.50 | 3% | 1.000 | 0.818 |
| Roman Urdu | 73 (16) | 0.959 (70/73) | 1.000 (73/73) | 0.029 | 0.057 | ≥ 0.90 / ≤ 0.50 | 11% | 1.000 | 0.688 |
| Arabic | 57 (8) | 0.982 (56/57) | 1.000 (57/57) | 0.014 | 0.057 | ≥ 0.80 / ≤ 0.50 | 2% | 1.000 | 1.000 |
| Hindi | 55 (9) | 1.000 (55/55) | 1.000 (55/55) | 0.003 | 0.039 | ≥ 0.80 / ≤ 0.50 | 0% | 1.000 | 1.000 |
| Urdu | 57 (8) | 1.000 (57/57) | 1.000 (57/57) | 0.003 | 0.041 | ≥ 0.80 / ≤ 0.50 | 0% | 1.000 | 1.000 |
| **All** | 381 (71) | 0.987 (376/381) | 1.000 (381/381) | 0.013 | 0.041 | ≥ 0.80 / ≤ 0.50 | 2% | 0.971 | 0.958 |

Band: Jev’s answer counts as "asks for a person" at or above the first number and as "does not" at or below the second; between them it abstains. Chosen as the lowest bound from 0.80 up whose "asks" answers were at least 95% right, and the highest "does not" bound at 95%. The floor is there because Jev can only add a hand-off the fixed rule missed, and a needless one makes the customer wait for a person.

The fixed rule is perfect here by construction: the hand-off fixtures are its own test cases, and the routing messages contain no request for a person. What matters is where Jev disagrees with it, because Jev only ever adds a hand-off the fixed rule missed.

### Routing intent

| Slice | Messages | Accuracy | Fixed rule | Brier | Calibration error | Threshold | Abstained | Accuracy when decided |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| English | 50 | 1.000 (50/50) | 0.760 (38/50) | 0.007 | 0.010 | 0.50 | 0% | 1.000 |
| Hinglish | 43 | 0.977 (42/43) | 0.860 (37/43) | 0.020 | 0.025 | 0.50 | 2% | 1.000 |
| Roman Urdu | 45 | 0.956 (43/45) | 0.844 (38/45) | 0.070 | 0.040 | 0.50 | 2% | 0.955 |
| Arabic | 43 | 0.953 (41/43) | 0.488 (21/43) | 0.058 | 0.031 | 0.50 | 2% | 0.976 |
| Hindi | 41 | 1.000 (41/41) | 0.610 (25/41) | 0.018 | 0.034 | 0.50 | 5% | 1.000 |
| Urdu | 44 | 0.977 (43/44) | 0.659 (29/44) | 0.034 | 0.039 | 0.50 | 2% | 0.977 |
| **All** | 266 | 0.977 (260/266) | 0.707 (188/266) | 0.034 | 0.014 | 0.50 | 2% | 0.985 |

Threshold: the lowest confidence (0.50 to 0.95 in steps of 0.05) at which at least 10 of Jev’s answers were decided and at least 95% of them were right. Below it Jev abstains and the fixed rule routes.

### Language

| Slice | Messages | Accuracy | Fixed rule | Brier | Calibration error | Threshold | Abstained | Accuracy when decided |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| English | 57 | 1.000 (57/57) | 1.000 (57/57) | 0.000 | 0.000 | 0.50 | 0% | 1.000 |
| Hinglish | 44 | 0.977 (43/44) | 0.045 (2/44) | 0.080 | 0.188 | 0.50 | 7% | 1.000 |
| Roman Urdu | 46 | 0.261 (12/46) | 0.109 (5/46) | 1.095 | 0.484 | none reaches 95% | 100% | – |
| Arabic | 44 | 1.000 (44/44) | 0.977 (43/44) | 0.001 | 0.019 | 0.50 | 0% | 1.000 |
| Hindi | 44 | 1.000 (44/44) | 1.000 (44/44) | 0.001 | 0.025 | 0.50 | 0% | 1.000 |
| Urdu | 45 | 0.956 (43/45) | 1.000 (45/45) | 0.071 | 0.075 | 0.50 | 2% | 0.955 |
| **All** | 280 | 0.868 (243/280) | 0.700 (196/280) | 0.204 | 0.057 | 0.90 | 27% | 0.966 |

Hinglish and Roman Urdu counted as one answer (Latin-script Hindustani): 0.989 (0.940–0.998, 89/90). The fixed rule’s "accuracy" counts an ambiguous answer (it asks the customer) as wrong.

When the product decides, it does not know the language yet: that is the question. So its thresholds are per language Jev answered. The share of each answer that was right:

| Jev answered | Answers | Right | Brier | Calibration error | Threshold | Set aside | Right when used |
| --- | --- | --- | --- | --- | --- | --- | --- |
| English | 58 | 0.983 (57/58) | 0.010 | 0.005 | 0.50 | 2% | 1.000 |
| Hinglish | 77 | 0.558 (43/77) | 0.675 | 0.266 | none reaches 95% | 100% | – |
| Roman Urdu | 13 | 0.923 (12/13) | 0.169 | 0.211 | 0.55 | 23% | 1.000 |
| Arabic | 45 | 0.978 (44/45) | 0.037 | 0.039 | 0.50 | 0% | 0.978 |
| Hindi | 44 | 1.000 (44/44) | 0.001 | 0.025 | 0.50 | 0% | 1.000 |
| Urdu | 43 | 1.000 (43/43) | 0.017 | 0.080 | 0.50 | 2% | 1.000 |

### Latency and cost

| Slice | Calls | p50 | p95 | Over 1.5 s |
| --- | --- | --- | --- | --- |
| English | 79 | 159 ms | 354 ms | 0 |
| Hinglish | 60 | 139 ms | 174 ms | 0 |
| Roman Urdu | 73 | 152 ms | 204 ms | 0 |
| Arabic | 57 | 150 ms | 210 ms | 0 |
| Hindi | 55 | 146 ms | 229 ms | 0 |
| Urdu | 57 | 142 ms | 192 ms | 0 |
| **All** | 381 | 148 ms | 214 ms | 0 |

Input tokens: 256,437 in total, 673 per call. Output tokens (free): 51,419. Cost: $0.0108 for the run, about $0.0000283 per decision.

### Defaults set from this run

`DEFAULT_DECISION_THRESHOLDS` in `@hamnivo/domain` holds these for `jev-1.13.0`; a language without one was not supported by the data, so Jev abstains there and the fixed rule decides.

| Slice | Routing: minimum confidence | Request for a person: band | Language: minimum confidence (by answer) |
| --- | --- | --- | --- |
| English | 0.50 | ≥ 0.80 / ≤ 0.50 | 0.50 |
| Hinglish | 0.50 | ≥ 0.80 / ≤ 0.50 | – |
| Roman Urdu | 0.50 | ≥ 0.90 / ≤ 0.50 | 0.55 |
| Arabic | 0.50 | ≥ 0.80 / ≤ 0.50 | 0.50 |
| Hindi | 0.50 | ≥ 0.80 / ≤ 0.50 | 0.50 |
| Urdu | 0.50 | ≥ 0.80 / ≤ 0.50 | 0.50 |

### U13 pairs

12 of 12 groups got the same answer for every variant (names, gender markers, politeness, script and language swapped).

## Errors (48, the 40 most confident shown)

| Task | Slice | Message | Expected | Jev | Confidence |
| --- | --- | --- | --- | --- | --- |
| language | Roman Urdu | Main password bhool gaya hoon aur reset email nahi aa rahi. | roman-urdu | hinglish | 0.98 |
| routing | Arabic | أرسلت السترة قبل أسبوعين، هل استلمتموها؟ | returns | shipping | 0.97 |
| language | Roman Urdu | Paanch din se tracking update nahi hui, kya masla hai? | roman-urdu | hinglish | 0.95 |
| language | Roman Urdu | Delivery wala mera ghar nahi dhoond saka, ab kya karoon? | roman-urdu | hinglish | 0.95 |
| language | Roman Urdu | Pro aur Lite model mein kya farq hai? | roman-urdu | hinglish | 0.94 |
| language | Roman Urdu | Courier keh raha hai deliver ho gaya, lekin mujhe kuch nahi mila. | roman-urdu | hinglish | 0.91 |
| language | Roman Urdu | Kya yeh charger iPhone 15 ke sath chale ga? | roman-urdu | hinglish | 0.90 |
| language | Roman Urdu | Kya is bag mein 16 inch ka laptop aa jaye ga? | roman-urdu | hinglish | 0.90 |
| language | Roman Urdu | Main aap ki website ke design ke baare mein raye dena chahta hoon. | roman-urdu | hinglish | 0.89 |
| language | Urdu | السلام علیکم! | ur | ar | 0.88 |
| person-request | Roman Urdu | kisi se | does not | p=0.87 | 0.87 |
| language | Roman Urdu | Main ne do hafte pehle jacket wapas bheji thi, kya aap ko mil gayi? | roman-urdu | hinglish | 0.86 |
| language | Roman Urdu | Apne account ka email kaise tabdeel karoon? | roman-urdu | hinglish | 0.86 |
| person-request | Roman Urdu | kya main insaan se baat kar raha hoon? | does not | p=0.86 | 0.86 |
| language | Roman Urdu | Jo blender mila woh nahi chal raha, kya main usay wapas bhej sakta hoon? | roman-urdu | hinglish | 0.84 |
| language | Roman Urdu | Mujhe apni company ke liye tax ki raseed chahiye. | roman-urdu | hinglish | 0.83 |
| language | Roman Urdu | Kya aap Dubai bhejte hain aur delivery ka kitna kharcha hai? | roman-urdu | hinglish | 0.82 |
| language | Roman Urdu | Card se adaigi nakam hui lekin paise kat gaye. | roman-urdu | hinglish | 0.81 |
| language | Roman Urdu | Mera refund kab aaye ga? Main ne pichle hafte order mansookh kiya tha. | roman-urdu | hinglish | 0.81 |
| language | Roman Urdu | Kya aap meri pichli khareedari ki raseed bhej sakte hain? | roman-urdu | hinglish | 0.80 |
| language | Roman Urdu | Kya aap kisi doosre pate par delivery kar sakte hain? | roman-urdu | hinglish | 0.80 |
| language | Roman Urdu | Ab main Google se sign in nahi kar pa raha. | roman-urdu | hinglish | 0.79 |
| language | Roman Urdu | Ek hi order ke liye mujh se do dafa raqam kaat li gayi. | roman-urdu | hinglish | 0.78 |
| language | Roman Urdu | Mere bill mein izafi charges kyun lage hain? | roman-urdu | hinglish | 0.78 |
| routing | Roman Urdu | Is qameez ko baray size se kaise tabdeel karoon? | returns | product | 0.78 |
| language | Roman Urdu | Wapsi ka label kahan se print karoon? | roman-urdu | hinglish | 0.77 |
| person-request | Arabic | هل أتحدث مع إنسان؟ | does not | p=0.77 | 0.77 |
| language | Roman Urdu | Kya main neela bag kaale bag se tabdeel kar sakti hoon? | roman-urdu | hinglish | 0.74 |
| language | Roman Urdu | Mujhe joote wapas karne hain, yeh chhote hain. | roman-urdu | hinglish | 0.73 |
| language | Roman Urdu | Main David hoon, mera refund kab milay ga? | roman-urdu | hinglish | 0.72 |
| language | Roman Urdu | Mujhe apne order ka refund chahiye. | roman-urdu | hinglish | 0.70 |
| language | Roman Urdu | Kya aap Itwaar ko khulay hote hain? | roman-urdu | hinglish | 0.67 |
| person-request | English | Please forward this to the human resources department | does not | p=0.67 | 0.67 |
| routing | Urdu | اس قمیض کو بڑے سائز سے کیسے بدلوں؟ | returns | product | 0.66 |
| language | Roman Urdu | Mujhe kisi banday se baat karni hai. | roman-urdu | hinglish | 0.63 |
| language | Roman Urdu | Kholi hui cheezon ki wapsi ki policy kya hai? | roman-urdu | hinglish | 0.57 |
| routing | Roman Urdu | Wapsi ka label kahan se print karoon? | returns | shipping | 0.56 |
| person-request | Roman Urdu | banday se baat nahi karni | does not | p=0.54 | 0.54 |
| language | Roman Urdu | Kya kaale rang mein 42 size dastiyab hai? | roman-urdu | hinglish | 0.53 |
| language | Urdu | اب میں گوگل سے سائن ان نہیں کر پا رہا۔ | ur | roman-urdu | 0.52 |


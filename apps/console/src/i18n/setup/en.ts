/**
 * Studio text for setting Hamnivo up without help (A01, A05, A06, G02, W03, W12), in English, the
 * source language: AI keys and their test, how the chat looks, the test chat, the setup wizard,
 * business hours, customer identity keys and support teams. Kept apart from the main file and
 * merged under `setup`, the way `migration` is.
 */
export const setupEn = {
  models: {
    intro:
      'An AI key lets your AI agents write answers. You get one from an AI company such as OpenAI, Anthropic or Google. Paste it here and we test it for you. Keys are stored encrypted and never shown again.',
    empty:
      'Add your first AI key so your agents can answer with a real AI. Without one they can only use the keys the server already holds (listed below) and the offline practice model, which gives canned replies.',
    addDescription:
      'Choose who gave you the key, paste it and pick a model. We save it encrypted and test it straight away.',
    model: 'Model',
    modelHint: 'The AI model to test the key with. The recommended one is a good place to start.',
    recommended: 'recommended',
    customModel: 'Another model…',
    customLabel: 'Model name',
    customHint: 'Type the model’s name exactly as the provider writes it.',
    customServerHint:
      'Type the name of a model your server offers, exactly as the server writes it.',
    tiers: { fast: 'fast, low cost', balanced: 'balanced', capable: 'most capable' },
    serverAddress: 'Server address',
    serverAddressHint:
      'The https:// address of your own OpenAI-compatible server, for example https://llm.example.com/v1.',
    labelHint:
      'A name for you and your team, such as “OpenAI production”. Left empty, we use the provider’s name.',
    moreOptions: 'More options',
    testNote:
      'After saving, we send one tiny test message of a few words to the provider to check the key works. It costs a tiny fraction of a cent.',
    saveAndTest: 'Save and test',
    errors: { model: 'Choose a model, or type its name.' },
    addedOn: 'added {{date}}',
    columns: { lastTest: 'Last test' },
    lastTest: { never: 'Not tested yet', ok: 'Worked' },
    test: 'Test key',
    testLabel: 'Test the key of {{label}}',
    testTitle: 'Test the key of {{label}}',
    testDescription:
      'We send one tiny message to the AI provider and show what came back. Nothing is added to your customers’ chats.',
    testing: 'Testing the key…',
    testingWith: 'Testing the key with {{model}}…',
    testAgain: 'Test again',
    testedWith: 'Tested with',
    probe: {
      ok: { title: 'The key works', body: 'The AI answered our test message.' },
      wrong_key: {
        title: 'The key wasn’t accepted',
        body: 'Check that you copied all of it and that it belongs to this provider. You can replace it from the list.',
      },
      no_credit: {
        title: 'No credit left',
        body: 'The key is real, but the account has no credit. Add credit with the provider, then test again.',
      },
      model_not_found: {
        title: 'Model not found',
        body: 'The provider doesn’t know this model name. Pick another model from the list, or check the spelling.',
      },
      network: {
        title: 'Couldn’t reach the provider',
        body: 'If you set a server address, check it, then try again in a minute.',
      },
      blocked: {
        title: 'That server address isn’t allowed',
        body: 'Use a public https:// address, or ask whoever runs your Hamnivo server.',
      },
      rate_limited: {
        title: 'The provider says slow down',
        body: 'Wait a minute and test again.',
      },
      unavailable: {
        title: 'The provider is having trouble',
        body: 'Try again in a few minutes.',
      },
      unknown: {
        title: 'The test didn’t work',
        body: 'We don’t know why. Try again, or check the key and the model with the provider.',
      },
    },
    replace: {
      action: 'Replace key',
      label: 'Replace the key of {{label}}',
      title: 'Replace the key of {{label}}',
      description:
        'Paste the new key. Agents that use this connection carry on with the new key, and the old one stops working. You may be asked to sign in again first.',
      newKey: 'New API key',
      newKeyHint:
        'The current key ends in {{hint}}. The new one is stored encrypted and never shown again.',
      submit: 'Replace and test',
      replaced: 'The key of {{label}} was replaced.',
      done: 'Key replaced. The new key ends in {{hint}}.',
    },
    server: {
      title: 'Keys on this server',
      description:
        'Whoever runs your Hamnivo server can give it AI keys of its own. Agents can use these without a connection here. We only show whether a key is set, never the key itself.',
      loading: 'Loading what the server is set up with',
      set: 'Key set',
      notSet: 'No key',
      jev: 'Jev',
      jevHint: 'Routes questions and double-checks answers. Optional.',
      jevOn: 'Set up',
      jevOff: 'Not set up',
      embeddings: 'Knowledge search',
      embeddingsMock:
        'Basic word matching, fine for trying things out. Searching by meaning needs an OpenAI or Google key on the server.',
      embeddingsReady: 'Searches by meaning using {{provider}}.',
      embeddingsMissing: 'Set to use {{provider}}, but the server has no key for it.',
      embeddingsOn: 'By meaning',
      embeddingsBasic: 'Basic',
      embeddingsNotReady: 'Not ready',
    },
  },
  home: {
    guided: 'Open guided setup',
    steps: {
      brand: {
        title: 'Add your brand and website',
        description: 'Name your brand and allow your website, so the chat can load there.',
      },
      engine: {
        title: 'Connect the chat engine',
        description: 'Connect it once for each brand, so chats reach your team.',
      },
      aikey: {
        title: 'Add an AI key',
        description:
          'Your AI agents need a key from an AI company such as OpenAI, Anthropic or Google to write real answers.',
      },
      agent: {
        title: 'Publish an AI agent',
        description:
          'Your assistant answers customers only after you publish it with a real AI model, not the offline practice one.',
      },
      team: {
        title: 'Invite a teammate',
        description: 'Add the people who will answer chats with you.',
      },
    },
  },
  leave: {
    title: 'Leave without saving?',
    description: 'You have changes that aren’t saved. If you leave now, they are lost.',
    keep: 'Keep editing',
    discard: 'Discard changes',
  },
  appearance: {
    open: 'Look and wording',
    openLabel: 'Change the look and wording of {{name}}’s chat',
    title: 'Look and wording of {{name}}’s chat',
    description:
      'Choose the colour, logo and words customers see. The picture beside the fields changes as you type, and nothing reaches customers until you save.',
    loading: 'Loading the look of the chat',
    previewTitle: 'What customers will see',
    previewNote: 'A picture of the chat. Use Test chat on the brand to try the real one.',
    previewLabel: 'Preview of the chat',
    previewLanguage: 'Language',
    previewState: 'Show when',
    stateOnline: 'The team is online',
    stateAway: 'The team is away',
    colour: {
      label: 'Main colour',
      hint: 'Used for the chat’s top bar, the send button and your customers’ messages. A colour code such as #D17B00.',
      pick: 'Pick the main colour',
      format: 'Use a colour code with a # and six letters or digits, such as #D17B00.',
      text: 'Text on this colour is hard to read.',
      faint: 'This colour is too close to white to stand out on a web page.',
      suggest: 'A slightly darker colour, {{colour}}, is easier to read.',
      apply: 'Use {{colour}}',
    },
    logo: {
      label: 'Logo web address',
      hint: 'The https:// address of a picture of your logo, such as https://example.com/logo.png. It is shown small, next to your brand name.',
    },
    radius: {
      label: 'Roundness of corners',
      value: '{{px}} px',
      hint: '0 is square. Higher numbers are rounder.',
    },
    greeting: {
      label: 'Greeting',
      hint: 'The first thing customers read. Leave it empty to use Hamnivo’s greeting. Write English first: other languages fall back to it.',
    },
    offline: {
      label: 'Message when nobody is online',
      hint: 'Customers read this when they ask for a person outside your business hours. Write {when} where the time your team is back should go. Leave it empty to use Hamnivo’s message.',
    },
    csat: {
      label: 'Ask customers to rate the chat',
      hint: 'When a chat ends, customers can give 1 to 5 stars and leave a comment.',
    },
    privacy: {
      label: 'Privacy policy web address',
      hint: 'Shown as a link at the bottom of the chat, such as https://example.com/privacy.',
    },
    urlProblem: 'Use a web address that starts with https:// and has no user name or password.',
    englishFirst: 'Write the English text first. Other languages fall back to it.',
    reset: 'Reset',
    save: 'Save look',
    saved: 'The look of {{name}}’s chat was saved.',
  },
  testChat: {
    open: 'Test chat',
    openLabel: 'Try the chat of {{name}}',
    needsEngine: 'Connect the chat engine for this brand first.',
    title: 'Test chat for {{name}}',
    description:
      'This is your real chat, running inside Studio. Send a message to see how it looks and what the AI answers.',
    frameTitle: 'Test chat for {{name}}',
    noteReal: 'It is the real chat: the AI answers with your real key and what it knows.',
    noteReports: 'Test chats are left out of your reports and counts.',
    noteUsage: 'They still use your plan like any chat, and they can show in your inbox.',
  },
  brand: 'Brand',
  hours: {
    nav: 'Business hours',
    title: 'Business hours',
    description:
      'Tell customers when your team answers. Outside these hours the chat says nobody is online and when you are back. Your AI assistant answers at any hour.',
    edit: 'Edit business hours',
    notSet: 'Not set. Until you set hours, the chat never says a person is available.',
    closedAlways: 'Closed every day',
    closedDays: 'Closed days: {{n}}',
    to: 'to',
    loading: 'Loading business hours',
    noBrands: {
      title: 'No brands yet',
      description: 'Business hours belong to a brand. Add a brand first.',
      action: 'Go to brands',
    },
    timezone: {
      label: 'Time zone',
      hint: 'The hours below are in this time zone, wherever your customers are.',
    },
    presets: {
      weekdays: 'Monday to Friday, 9:00 to 17:00',
      everyday: 'Every day, all day',
      closed: 'Closed every day',
    },
    week: {
      title: 'Weekly hours',
      hint: 'Tick the days your team answers and set the times. A closing time of 12:00 AM means midnight at the end of that day.',
      open: 'Open',
      opens: 'Opens',
      closes: 'Closes',
      add: 'Add another time',
      remove: 'Remove this time on {{day}}',
    },
    holidays: {
      title: 'Days closed',
      description:
        'Public holidays and other whole days when nobody answers. On these days the chat says nobody is online.',
      date: 'Day',
      add: 'Add day',
      remove: 'Remove {{date}}',
      none: 'No days closed.',
    },
    problems: {
      time: 'Enter an opening and a closing time for {{day}}.',
      order: 'On {{day}}, closing must be after opening.',
      overlap: 'On {{day}}, the times must not overlap.',
      zone: 'Choose a time zone from the list.',
      date: 'One of the closed days is not a date.',
    },
    save: 'Save hours',
    saved: 'The business hours of {{name}} were saved.',
    reset: 'Reset',
    unsaved: 'You have changes that aren’t saved.',
    noPermission: 'Ask an owner or administrator to change business hours.',
    remove: {
      action: 'Remove hours',
      title: 'Remove the hours of {{name}}?',
      body: 'The chat then never says a person is available. You can set hours again at any time.',
      confirm: 'Remove hours',
      done: 'The hours of {{name}} were removed.',
    },
  },
  identity: {
    nav: 'Customer sign-in',
    title: 'Customer sign-in',
    description:
      'Let your website tell Hamnivo who a signed-in customer is, so they see their own chats on every device. A developer sets this up; if your customers don’t sign in to your website, you can skip it.',
    guide: 'Read the guide for developers',
    loading: 'Loading customer sign-in keys',
    noBrands: 'Customer sign-in belongs to a brand. Add a brand first.',
    noPermission: 'Ask an owner or administrator to manage these keys.',
    empty: {
      title: 'No keys yet',
      description:
        'Your website’s server signs a short note about the customer with a key. Create the key here and give it to your developer.',
    },
    columns: {
      name: 'Key name',
      type: 'Type',
      status: 'Status',
      added: 'Added',
      actions: 'Actions',
    },
    algs: {
      HS256: 'Shared secret (HS256)',
      ES256: 'Public key (ES256)',
      EdDSA: 'Public key (EdDSA)',
      RS256: 'Public key (RS256)',
    },
    status: { active: 'Active', retiring: 'Retiring', revoked: 'Revoked' },
    create: {
      action: 'Create a key',
      title: 'Create a customer sign-in key',
      description:
        'Managing keys needs two-step verification and a recent sign-in. You may be asked to sign in again.',
      kind: 'What kind of key?',
      secret: 'A shared secret',
      secretHint: 'Hamnivo makes it for you and shows it once. The easiest way to start.',
      public: 'A public key',
      publicHint: 'You keep the private key on your server and give Hamnivo only the public half.',
      alg: 'Signature type',
      jwk: {
        label: 'Public key (JWK)',
        hint: 'Paste the public key as JSON. Never paste a private key: Hamnivo refuses it.',
        json: 'This is not valid JSON.',
        object: 'Paste one key as a JSON object.',
        private: 'This looks like a private key. Paste only the public half.',
      },
      name: 'Key name',
      nameHint:
        'Letters, digits, dot, underscore and dash, up to 64. Left empty, Hamnivo picks one.',
      nameInvalid: 'Use only letters, digits, dot, underscore and dash, up to 64.',
      submitSecret: 'Create secret',
      submitPublic: 'Register key',
    },
    rotate: {
      action: 'Replace',
      label: 'Replace the key {{kid}}',
      title: 'Replace the key {{kid}}',
      description:
        'We create a new key of the same kind and mark this one as retiring. A retiring key still works, so your server can switch over without a gap.',
      retireFailed:
        'The new key was created, but {{kid}} could not be marked as retiring. Try Replace again on its row, or revoke it when nothing uses it.',
    },
    revoke: {
      action: 'Revoke',
      label: 'Revoke the key {{kid}}',
      title: 'Revoke the key {{kid}}?',
      body: 'Anything signed with this key is refused from now on. Only do this when you are sure your server no longer uses it.',
      confirm: 'Revoke key',
      done: 'The key {{kid}} was revoked.',
    },
    how: {
      title: 'Changing a key without a gap',
      description: 'Do it in this order so customers are never locked out.',
      step1:
        'Press Replace on the key that is in use. A new key is made and the old one is marked retiring.',
      step2: 'Give the new key to your developer, who switches your website’s server to it.',
      step3: 'When nothing uses the old key any more, press Revoke on it.',
    },
    created: 'The key {{kid}} was created.',
    reveal: { title: 'Your new secret', label: 'Secret for the key {{kid}}' },
  },
  teams: {
    nav: 'Support teams',
    title: 'Support teams',
    description:
      'Who is in each team. Teams are what chats are handed to. Add or take out people here.',
    loading: 'Loading teams',
    noPermission: 'Ask an owner or administrator to change teams.',
    empty: {
      title: 'No teams yet',
      description:
        'A team is a group of people who answer chats together, such as “Support” or “Sales”.',
    },
    create: 'Create a team',
    createTitle: 'Create a team',
    createDescription: 'Give the team a name. You add its people next.',
    name: 'Team name',
    nameHint: 'For example “Support” or “Sales”.',
    nameRequired: 'Give the team a name.',
    created: 'The team {{name}} was created.',
    archived: 'Archived',
    count: 'People in this team: {{n}}',
    noMembers: 'Nobody is in this team yet.',
    remove: 'Take {{name}} out of {{team}}',
    removed: '{{name}} was taken out of {{team}}.',
    addLabel: 'Add a person',
    choose: 'Choose a person',
    everyone: 'Everyone is already in this team',
    add: 'Add to team',
    added: '{{name}} was added to {{team}}.',
    rules: 'Teams get chats through the rules of each brand.',
    rulesLink: 'Open the rules',
  },
  install: {
    platforms: {
      html: 'Any website',
      wordpress: 'WordPress',
      woocommerce: 'WooCommerce',
      shopify: 'Shopify',
      wix: 'Wix',
      squarespace: 'Squarespace',
      webflow: 'Webflow',
      'google-tag-manager': 'Google Tag Manager',
      react: 'React',
      nextjs: 'Next.js',
    },
  },
  onboarding: {
    title: 'Welcome to Hamnivo',
    description:
      'Set up in a few minutes. Every step can be skipped and done later, and nothing you did is lost if you leave.',
    later: 'Finish later',
    loading: 'Loading your setup',
    railLabel: 'Setup steps',
    count: '{{done}} of {{total}} steps dealt with',
    stepOf: 'Step {{n}} of {{total}}',
    back: 'Back',
    skip: 'Skip this step',
    continue: 'Continue',
    needsBrand: 'This step needs a brand. Add one first.',
    toBrand: 'Add a brand',
    state: { done: 'Done', skipped: 'Skipped', todo: 'Not done yet' },
    steps: {
      workspace: {
        name: 'Workspace',
        title: 'Your workspace',
        description: 'This is where everything about your business lives.',
      },
      brand: {
        name: 'Brand and website',
        title: 'Your brand and website',
        description:
          'A brand has its own chat, allowed website and AI assistant. Tell us its name and where the chat will appear.',
      },
      engine: {
        name: 'Chat engine',
        title: 'Connect the chat engine',
        description:
          'The chat engine carries your customers’ messages to your team. It sets itself up.',
      },
      aikey: {
        name: 'AI key',
        title: 'Add an AI key',
        description:
          'An AI key lets your AI agents write answers. Paste one from an AI company and we check it works.',
      },
      testchat: {
        name: 'Test chat',
        title: 'Try the chat yourself',
        description: 'Send a message to your own chat, before any customer sees it.',
      },
      install: {
        name: 'Install',
        title: 'Put the chat on your website',
        description: 'Choose where your website is built, then copy the code into it.',
      },
      team: {
        name: 'Team',
        title: 'Invite your team',
        description: 'Bring in the people who will answer chats with you. You can do this later.',
      },
    },
    workspace: {
      ready: 'Your workspace {{name}} is ready.',
    },
    brand: {
      existing: 'Brand to set up',
      existingHint: 'These brands already exist in your workspace.',
      use: 'Continue with {{name}}',
      addAnother: 'Add a different brand',
      website: 'Your website',
      websiteHint:
        'Where the chat will appear, such as noor.example. Only this website may show the chat. You can change it later.',
      create: 'Create brand',
      websiteInvalid:
        '{{value}} isn’t a website address. Write it like noor.example or https://noor.example.',
      useExisting: 'Use a brand I already have',
    },
    engine: {
      checking: 'Checking your chat engine…',
      working: 'Setting up the chat engine for {{name}}. This takes a moment.',
      ready: 'Your chat engine is ready.',
      retry: 'Try again',
      disabled: 'The connection is turned off. Ask an administrator to turn it on.',
    },
    aikey: {
      noPermission:
        'Only people who manage connections can add an AI key. Ask an owner or administrator, or skip this step.',
      serverKey:
        'This server already holds an AI key of its own, so your agents can answer even without one here. Add yours to use your own account.',
      have: 'You already have an AI key. Test it to make sure it works.',
    },
    testchat: {
      toEngine: 'Go to the chat engine step',
      done: 'It works, continue',
    },
    install: {
      platform: 'Where is your website built?',
      platformHint: 'We link the guide for it. If you are not sure, keep “Any website”.',
      guide: 'Open the installation guide: {{platform}}',
      where: 'Where does this code go?',
      whereBody:
        'Paste it into every page where the chat should appear, just before the closing </body> tag. On a website builder, look for a place to add custom code or a script to the footer. The guide above shows the exact place.',
      addWebsite: 'Add your website',
      cannotCheck:
        'We can’t see your website from here, so we can’t check the code is on it. After you add it, open your website: the chat button should appear. Send a message from it and it shows up in your inbox.',
      done: 'I’ve added the code',
    },
    team: {
      none: 'Nobody else is here yet. You can invite people now or later.',
      some: 'People in your workspace besides you: {{people}}. Invitations sent: {{invited}}.',
      invite: 'Invite a teammate',
      finish: 'Finish setup',
      noPermission: 'Ask an owner or administrator to invite people.',
    },
    finished: {
      title: 'You’re all set',
      titleOpen: 'Setup saved',
      description: 'Everything is done. You can change any of it later from the menu.',
      descriptionOpen:
        'Steps left: {{n}}. You can do them now or any time later; the list on Home keeps track.',
      doSkipped: 'Do it now',
      doTodo: 'Do it now',
      go: 'Go to Overview',
    },
  },
} as const;

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English keys; TypeScript reports a missing one. */
export type SetupTranslation = Strings<typeof setupEn>;

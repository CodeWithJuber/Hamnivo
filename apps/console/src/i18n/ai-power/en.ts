/**
 * Studio text for the AI power tools (D10, G04, G17): signing in to MCP services, what they list,
 * the catalog of services, websites as knowledge, what the AI remembers about a customer, the
 * "Test your AI" playground and custom HTTP tools. English is the source language; merged under
 * `aiPower`, apart from the main file so it can grow on its own.
 */
export const aiPowerEn = {
  mcp: {
    preset: {
      label: 'Start from a service',
      other: 'Another service (enter its address)',
      hint: 'Addresses the services publish themselves. Pick one to fill in the name and address.',
      docs: 'The service’s own page about this address',
      verified: 'Address checked against the service’s page on {{date}}.',
      summaries: {
        'intercom-us': 'Look up conversations, contacts and help center articles in Intercom.',
        'intercom-eu': 'Look up conversations, contacts and help center articles in Intercom.',
        gorgias: 'Read tickets and customers in your Gorgias help desk.',
        stripe: 'Look up customers, payments, subscriptions and refunds in Stripe.',
        klaviyo: 'Read customer profiles, lists and campaign results in Klaviyo.',
        calendly: 'Check availability and scheduled events in Calendly.',
        linear: 'Find and read issues and projects in Linear.',
        notion: 'Search and read pages and databases in Notion.',
        atlassian: 'Find and read Jira issues and Confluence pages.',
        asana: 'Find and read tasks and projects in Asana.',
        monday: 'Find and read boards and items in monday.com.',
        sentry: 'Look up errors and issues in Sentry.',
        github: 'Search and read repositories, issues and pull requests on GitHub.',
      },
      notes: {
        'intercom-us': 'Use this one when your Intercom workspace is hosted in the US.',
        'intercom-eu': 'Use this one when your Intercom workspace is hosted in the EU.',
        gorgias: 'Gorgias asks for your account name when you sign in.',
        stripe: 'Sign in with OAuth, or paste a Stripe agent API key as the token.',
        linear: 'Linear also has a read-only address, https://mcp.linear.app/mcp/readonly.',
        asana:
          'If Asana asks for a client ID, create an app in Asana’s developer console and enter it.',
        github: 'Create a personal access token on GitHub and paste it as the token.',
      },
      auth: {
        oauth: 'You sign in with your browser. No token is needed.',
        oauth_or_token: 'You sign in with your browser, or paste a token from the service.',
        token: 'The service gives you a token to paste.',
      },
    },
    auth: {
      none: 'No sign-in or token',
      token: 'Token {{masked}}',
      oauth: 'Signed in through {{host}}',
      needsReconnect: 'The sign-in stopped working. Sign in again.',
      expires: 'Renews itself before {{time}}',
    },
    actions: {
      signIn: 'Sign in',
      signInAgain: 'Sign in again',
      signOut: 'Sign out',
      edit: 'Edit',
      remove: 'Remove',
      catalog: 'Resources and prompts',
      signInLabel: 'Sign in to {{name}}',
      signOutLabel: 'Sign out of {{name}}',
      editLabel: 'Edit {{name}}',
      removeLabel: 'Remove {{name}}',
      catalogLabel: 'See what {{name}} offers besides tools',
    },
    signIn: {
      title: 'Sign in to {{name}}',
      description:
        'You go to the service to sign in and allow Hamnivo, then you come back here. Hamnivo never sees your password.',
      continue: 'Continue to the service',
      manual: 'Enter a client ID',
      manualHint:
        'Only if the service asked for one: some services do not let Hamnivo register itself. Use the redirect address below when you create the client there.',
      redirect: 'Redirect address',
      clientId: 'Client ID',
      clientSecret: 'Client secret',
      clientSecretHint: 'Only if the service gave you one.',
      needsClient:
        'This service does not let Hamnivo register itself. Enter the client ID the service gave you.',
      leaving: 'Going to the service…',
      signedOut: 'Signed out of {{name}}.',
    },
    signOut: {
      title: 'Sign out of {{name}}?',
      body: 'Hamnivo tells the service to forget its access, and deletes the saved sign-in. The tools stay, but they cannot run until you sign in again or add a token.',
      confirm: 'Sign out',
    },
    callback: {
      title: 'Signing in',
      working: 'Finishing the sign-in…',
      done: 'Signed in to {{name}}.',
      synced: 'Its tools are listed under Tools: look at each one before turning it on.',
      syncFailed: 'Signed in, but the tools could not be listed yet. Check the service again.',
      refused: 'The service did not allow the sign-in.',
      failed: 'The sign-in did not finish.',
      ended: 'This sign-in has ended or was started by someone else. Start it again from Tools.',
      missing: 'This page is for finishing a sign-in. Start one from Tools.',
      back: 'Back to Tools',
    },
    edit: {
      title: 'Edit {{name}}',
      description: 'Change its name, its address or its token.',
      label: 'Name',
      url: 'Address',
      token: 'New token',
      tokenHint:
        'Leave this empty to keep what is saved. A new token replaces a sign-in. It is stored encrypted and never shown again.',
      removeToken: 'Remove the saved token',
      removeSignIn: 'To remove a sign-in, use Sign out.',
      urlWarning:
        'If the address changes, the tools go back to review and what the service lists is read again. A saved token stays only when the new address is on the same site, and a sign-in ends.',
      save: 'Save changes',
      saved: '{{name}} was updated.',
      nothing: 'Nothing was changed.',
    },
    remove: {
      title: 'Remove {{name}}?',
      body: 'Its tools are turned off and leave the list, requests waiting on them are cancelled, and its token or sign-in is deleted. What they did stays in the log. You can connect the same address again later.',
      confirm: 'Remove',
      done: '{{name}} was removed.',
    },
    catalog: {
      title: 'What {{name}} offers',
      description:
        'The resources and prompts the service listed at the last check, besides tools. The words in quotes come from the service.',
      checked: 'Listed {{time}}',
      neverChecked: 'Check the service first to see what it offers.',
      resources: 'Resources',
      resourcesNote:
        'Documents and data the service offers. Agents with the “Read a resource” tool can read the ones you switch on, and no others.',
      noResources: 'The service lists no resources.',
      readable: 'Agents may read this',
      readableLabel: 'Let agents read {{name}}',
      readableHint: 'Only with the “Read a resource” tool.',
      type: 'Type',
      size: 'Size',
      uri: 'Address',
      fromService: 'From the service',
      prompts: 'Prompts',
      promptsNote:
        'Ready-made requests the service offers. They are listed for you to see; agents do not use them.',
      noPrompts: 'The service lists no prompts.',
      arguments: 'Asks for',
      required: 'required',
      needTool:
        'Agents read resources with the “Read a resource” tool. Add it under Tools, then give it to an agent.',
      saved: 'Saved.',
      loading: 'Loading what the service offers',
    },
  },
} as const;

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English keys; TypeScript reports a missing one. */
export type AiPowerTranslation = Strings<typeof aiPowerEn>;

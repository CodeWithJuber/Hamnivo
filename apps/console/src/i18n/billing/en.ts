/**
 * Studio text for running Hamnivo as a service: Plan and billing, the sign-up switch and
 * Turnstile, suspension, the automatic chat set-up and the platform console's plans and operator
 * keys. English, the source language. Kept apart from the main file; merged under `billing`.
 */
export const billingEn = {
  nav: 'Plan and billing',
  title: 'Plan and billing',
  description: 'Your plan, what you used this month, your invoices, and the name on your emails.',
  loading: 'Loading your plan',
  checkout: {
    done: 'Thank you. Your payment is being confirmed, and your plan changes in a moment.',
    cancelled: 'You left the payment page. Nothing was charged.',
  },
  plan: {
    title: 'Your plan',
    none: 'No plan: nothing is limited',
    price: '{{price}} a month',
    provider: {
      free: 'Free. You can upgrade when you need more.',
      stripe: 'Paid by card through Stripe.',
      whmcs: 'Billed by your provider. Use the client area to pay or change the plan.',
      manual: 'Billed by invoice from this server.',
    },
    grace:
      'A payment failed. Your plan stays until {{date}}. Pay the invoice before then to keep it; otherwise the workspace moves to the free plan.',
    trial:
      'Trial until {{date}}. After that the workspace moves to the free plan unless you choose a plan.',
    renews: 'Renews on {{date}}.',
    ends: 'Ends on {{date}}. It does not renew.',
  },
  status: {
    none: 'No subscription',
    trialing: 'Trial',
    active: 'Active',
    past_due: 'Payment due',
    unpaid: 'Unpaid',
    canceled: 'Cancelled',
    incomplete: 'Waiting for payment',
    paused: 'Paused',
  },
  providers: {
    free: 'Free',
    stripe: 'Stripe',
    whmcs: 'WHMCS',
    manual: 'Invoices from this server',
  },
  actions: {
    manage: 'Manage billing',
    clientArea: 'Open client area',
    upgrade: 'Upgrade',
    chooseLabel: 'Upgrade to {{plan}}',
  },
  plans: {
    title: 'Plans',
    description:
      'Choose a plan to pay for it on a secure payment page. You can change or cancel it later.',
    limit: '{{limit}}: {{value}}',
    unlimited: 'no limit',
    trialDays: 'Trial: {{n}} days free',
    readOnly: 'Only people who manage billing can change the plan.',
  },
  usage: {
    title: 'Usage this month',
    details: 'Details and AI budget',
  },
  invoices: {
    title: 'Invoices',
    loading: 'Loading invoices',
    number: 'Invoice',
    date: 'Date',
    total: 'Total',
    status: 'Status',
    links: 'Links',
    pay: 'Pay',
    view: 'View',
    pdf: 'PDF',
    empty: 'No invoices yet.',
    allInReports: 'All invoices',
    inClientArea: 'Your invoices are in your provider’s client area.',
    statuses: {
      draft: 'Draft',
      open: 'Open',
      paid: 'Paid',
      void: 'Void',
      uncollectible: 'Not collected',
    },
  },
  sender: {
    title: 'Email sender name',
    description:
      'The name people see on emails from this workspace, such as invitations, receipts and payment notices.',
    loading: 'Loading the sender name',
    label: 'Sender name',
    hint: 'Leave it empty to use the workspace name ({{name}}).',
    save: 'Save sender name',
    saved: 'Sender name saved.',
  },
  suspended: {
    title: 'This workspace is suspended',
    description:
      'You can look around, but nothing can be changed, and the chat on your website shows as offline. Contact your provider to reactivate it.',
  },
  provisioning: {
    queued: 'Chat for this brand is being set up. This takes about a minute.',
    running: 'Setting up chat: {{step}}',
    failed:
      'Chat set-up stopped. {{error}} Select Connect Chatwoot to try again: it continues where it stopped.',
    steps: {
      account: 'creating the account',
      integration_user: 'adding Hamnivo’s user',
      account_user: 'giving Hamnivo access',
      inbox: 'creating the inbox',
      bot: 'adding the AI assistant',
      bot_attached: 'connecting the AI assistant',
      webhook: 'turning on updates',
      dashboard_app: 'adding the copilot',
      done: 'finishing',
    },
  },
  signup: {
    closed:
      'Sign-up is by invitation on this server. If you were invited, use the address the invitation was sent to.',
    closedError:
      'This server only creates accounts for invited addresses. Use the address your invitation was sent to, or ask for an invitation.',
    captcha: 'Confirm you are a person',
    captchaMissing: 'Complete the check above, then try again.',
    captchaFailed: 'The check did not pass. Try it again.',
    captchaUnavailable:
      'The check could not load. Check your connection or turn off content blockers, then reload the page.',
  },
  tenants: {
    suspended: 'Suspended: read-only',
    createClosed:
      'Creating workspaces is turned off on this server. Your provider creates them, or invites you to one.',
  },
  platform: {
    nav: 'Sign-up and billing',
    signup: {
      title: 'Public sign-up',
      description:
        'Whether anyone can create an account and a workspace on this server. Invited people can always join.',
      loading: 'Loading the sign-up setting',
      open: 'Open to everyone',
      closed: 'By invitation only',
      overridden: 'Changed here on {{time}}',
      envDefault: 'Server setting (HAMNIVO_PUBLIC_SIGNUP): {{state}}',
      openShort: 'open',
      closedShort: 'closed',
      turnstileOn: 'Cloudflare Turnstile checks every sign-up.',
      turnstileOff:
        'Cloudflare Turnstile is off. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY to turn it on.',
      defaultPlan: 'New workspaces start on: {{plan}}',
      unlimited: 'no plan (nothing limited)',
      close: 'Close sign-up',
      openIt: 'Open sign-up',
      follow: 'Use the server setting',
      needsAdmin: 'Only platform admins can change this.',
      saved: 'Sign-up setting saved.',
    },
    plans: {
      title: 'Plans',
      description:
        'Add or change plans with the billing command, plan:set (see the guide to running Hamnivo as a service).',
      loading: 'Loading plans',
      name: 'Name',
      key: 'Key',
      price: 'Price a month',
      trial: 'Trial',
      stripe: 'Stripe price',
      trialDays: '{{n}} days',
    },
    keys: {
      title: 'Operator API keys',
      description:
        'Billing systems such as WHMCS use a key to create, suspend and change workspaces. A key is shown once, when it is created.',
      loading: 'Loading keys',
      name: 'Name',
      nameHint: 'Where the key is used, for example WHMCS.',
      nameRequired: 'Give the key a name.',
      create: 'Create key',
      created: 'Copy this key now and store it in the billing system. It is not shown again.',
      copy: 'Copy key',
      copied: 'Key copied.',
      copyFailed: 'Copying did not work. Select the key and copy it yourself.',
      empty: 'No keys yet.',
      prefix: 'Starts with',
      createdAt: 'Created',
      lastUsed: 'Last used',
      status: 'Status',
      never: 'Never',
      active: 'Active',
      revoked: 'Revoked',
      revoke: 'Revoke',
      revokeLabel: 'Revoke the key {{name}}',
      revokeTitle: 'Revoke the key {{name}}?',
      revokeBody: 'Systems that use this key stop working right away. This cannot be undone.',
      revokedDone: 'Key revoked.',
    },
    tenant: {
      title: 'Plan and state',
      loading: 'Loading the plan',
      plan: 'Plan',
      noPlan: 'No plan (nothing limited)',
      trial: 'trial until {{date}}',
      provider: 'Billed by',
      graceLabel: 'Payment',
      grace: 'Failed; grace period until {{date}}',
      usage: 'Usage this period',
      assign: 'Change plan',
      assignTitle: 'Change the plan of {{name}}',
      planField: 'Plan',
      pickPlan: 'Choose a plan',
      startTrial: 'Start the plan’s trial ({{n}} days), then fall back to the free plan',
      stripeNote:
        'This workspace pays through Stripe. Change its plan in Stripe, or cancel the subscription first.',
      assigned: 'Plan changed.',
      suspend: 'Suspend',
      reactivate: 'Reactivate',
      suspendTitle: 'Suspend {{name}}?',
      reactivateTitle: 'Reactivate {{name}}?',
      suspendBody:
        'Its people can still sign in and look, but nothing can be changed, and the chat on its websites shows as offline.',
      reactivateBody: 'Everything works again, including the chat on its websites.',
      reason: 'Reason',
      reasonHint: 'Recorded in the workspace’s audit log and in the platform audit log.',
      reasonShort: 'Write a reason of at least 3 characters.',
      suspendedDone: 'Workspace suspended.',
      reactivatedDone: 'Workspace reactivated.',
    },
  },
} as const;

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English keys; TypeScript reports a missing one. */
export type BillingTranslation = Strings<typeof billingEn>;

# What a suspended customer sees

You suspend a workspace from the platform console (**Tenants**, the workspace, **Suspend**), or
WHMCS suspends it when an invoice is overdue. Suspension is reversible: nothing is deleted.

## The workspace's people, in Studio

- They can still sign in and open the workspace.
- A banner on every page says: "This workspace is suspended. You can look around, but nothing can
  be changed, and the chat on your website shows as offline. Contact your provider to reactivate
  it."
- Everything is readable: conversations, customers, settings, reports.
- Every change is refused with that reason: replying, editing settings, inviting people, and so on.
- **Settings → Plan and billing** stays open, and **Manage** still works, so the owner can pay.

## Visitors on the workspace's websites

- The chat button still appears.
- A new chat cannot start. The chat says: "This chat is offline right now. Please try again
  later." (in the visitor's language).
- An open chat can no longer send messages, and shows offline when it reconnects.

Chatwoot is not changed, and conversations stay where they are.

## Reactivating

Choose **Reactivate** in the console, or unsuspend the service in WHMCS. Studio and the chat work
again at once; visitors can start new chats.

## Suspended or terminated?

| | Suspended | Terminated (closed) |
|---|---|---|
| Staff open Studio | Yes, read-only | No |
| Website chat | Shows offline | Not available |
| Can be undone | Yes | No: create a new workspace |
| Data | Kept | Kept until you delete it |

Both are recorded with their reason in the workspace's audit log and in the platform audit log.

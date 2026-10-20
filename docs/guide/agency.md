# Agency clients

Agency mode lets one workspace keep a directory of separate client workspaces. Each client has its own members, roles, brands, conversations, AI settings, and data. Existing workspaces are never added automatically.

An owner can enable agency mode with `PATCH /v1/admin/agency` and `{"enabled":true}` using the agency workspace in `X-Hamnivo-Tenant`. The route requires tenant-wide `agency.manage` and a recent sign-in. After activation, **Agency clients** appears in Studio for members with `agency.read`.

On the **Agency clients** page, an agency manager can create a client by entering its name and handle. This creates a new independent workspace, links it in the directory, and makes the creator its owner. Creation works even when public workspace signup is closed. The manager can also link an existing workspace by entering its tenant ID, provided they have tenant-wide `grants.manage` in that workspace too. A client can belong to only one agency directory, and agencies cannot be nested.

The directory shows each client's name, handle, status, and whether **you** can open it. A directory link never grants access to client content. To see a client's conversations or settings, a person needs a membership and explicit role grant in that client workspace. Studio shows **Switch** only when the signed-in person has an active client membership. Grant or revoke client access through that client's normal member and role management.

For AI usage, an agency pays for clients it creates through **Agency clients**. A workspace linked later keeps its existing payer. **Unlink** removes only the directory entry: the client workspace, its data and memberships, and its AI payer stay as they were. A client funded by one agency cannot be linked to another agency without a separate funding transfer.

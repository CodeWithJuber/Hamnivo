# How the chat looks

You can change the colour, logo, words, light or dark, and the launcher button of your chat, so
it looks like your business. Each brand has its own look. You see a picture of the chat change
as you type, and nothing reaches your customers until you press **Publish**.

## The home screen

Before a customer writes, the chat shows your greeting in your main colour. While someone on your
team is online, it shows who, with their photos (or initials) and first names, and how soon your
team usually replies. One **Chat with us** button takes the customer straight to the message box.
Each teammate chooses their own first name and photo
([how](../inbox/sounds-and-notifications.md#how-customers-see-you)).

The top of the chat keeps to a few controls: language, **More** and close (and, on a computer,
**Make the chat larger**). Memory, past chats and settings are in **More**.

## Open the editor

1. Open **Settings** in the menu, then **Chat widget**.
2. Choose your brand under **Brand**, then the **Look** tab.

You can also press **Chat widget** on your brand's card in **Brands and install**.

Only an owner or administrator can change the look. If you do not see the button, ask one of them.

The page has the fields on the left and a picture of your chat on the right. Under the picture
you can choose a **Language**, and whether it shows the chat while **the team is online** or
**the team is away**. Use these to check every language your customers use, and the message
customers read when nobody is online. Arabic and Urdu show right to left. When you choose a
launcher picture, the picture shows the launcher button under the chat too.

## What you can change

### Main colour

The colour of the chat's top bar, the send button, the launcher and your customers' messages.
Type a colour code, such as `#D17B00`, or press the coloured square and pick one.

Studio checks that the writing on your colour can be read, and that the colour does not fade into
a white web page. If it fails, Studio says why and suggests a slightly darker colour. Press **Use**
followed by the colour to accept it. You cannot save a colour that fails.

### Logo web address

The `https://` address of a picture of your logo, such as `https://example.com/logo.png`. It
appears small, next to your brand name. Leave it empty for no logo. The address must start with
`https://`, and it must open the picture itself, not a web page that shows it.

### Roundness of corners

A slider from 0 (square corners) to 24 (very round). The picture shows the effect.

### Typography

The letters the chat uses: **System** (the visitor's own device font), **DM Sans** or
**Noto Sans**. Noto Sans covers Arabic, Hindi and Urdu well.

### Light or dark

- **Follow the website** (the default): the chat is dark only on a dark website. It looks at the
  website's own background, and at the colour scheme the website says it uses. It changes when
  the website changes, for example when a visitor switches the website to dark. It does not turn
  dark only because the visitor's phone or computer is dark.
- **Light** or **Dark**: always that, on every website.

On a dark chat, the top bar is a calm dark colour, so your writing stays readable. Your main
colour stays on the launcher, the send button and buttons.

A developer can still decide for one website with `data-theme` on the script, which comes before
this setting. [All the options of the install code](../integrations/html.md).

### Header

- **Brand colour** (the default): the top bar and the welcome area are in your main colour.
- **Plain**: the top bar is white (or dark on a dark chat), with a thin line under it. Choose this
  when your main colour is strong and you want a quieter chat.

### Launcher picture and size

The round button that opens the chat. Choose its picture (**Round speech bubble**, **Square
speech bubble**, **Question mark** or **Sparkle**) and its size: **Small** (48 pixels),
**Medium** (56, the default) or **Large** (64). On every size the button is easy to press with a
finger.

### Launcher label

Optional words beside the launcher, such as "Chat with us". As with the greeting, write English
first. Leave it empty for a button without words.

### Show Hamnivo branding

When on, a small "Hamnivo" shows at the bottom of the chat.

### Greeting

The first thing customers read. Leave all the boxes empty to use Hamnivo's own greeting. If you
write one, write the **English** box first. The Arabic, Hindi and Urdu boxes are optional: a
customer whose language you left empty reads your English text.

### Message when nobody is online

What customers read when they ask for a person outside your [business hours](business-hours.md).
Where your text says `{when}`, the chat puts in the time your team is back, in the customer's
language and your time zone. For example:

> We are closed. Back {when}. Thank you!

Leave it empty to use Hamnivo's own message. As with the greeting, write English first.

### Ask customers to rate the chat

When on, a customer who finishes a chat can give 1 to 5 stars and write a comment. It is off by
default.

### Privacy policy web address

When you give an `https://` address, the chat shows a **Privacy policy** link at the bottom. It
opens in a new tab. Leave it empty for no link.

## Where the launcher sits

These are on the **Behaviour** tab of the same page, under **Where the chat appears**. They
apply to the floating button and the side panel.

- **Button corner**: bottom right or bottom left.
- **Space from the side** and **Space from the bottom**: how far the launcher is from the edges
  of the window, in pixels, from 0 to 400. Leave both empty for the usual 20. Move it up when
  your website has its own button in that corner, such as a cookie notice or "back to top".
- **No button on phones**: on screens up to 480 pixels wide there is no launcher. Your website
  can still open the chat with a link or button of its own that calls `Hamnivo.open()`.

A developer's `data-offset-x`, `data-offset-y`, `data-size`, `data-icon` and
`data-hide-on-mobile` on the script come before these settings, for that one website.

## Next questions under AI answers

On the **Behaviour** tab, under **Help before a conversation**, **Suggest next questions under AI
answers** is on by default. After the AI assistant answers, up to three short questions the
customer might ask next appear under the answer; pressing one sends it. They are written after
the answer is sent, so the answer itself is never slower. Each set uses a few AI credits. Turn
it off to show none.

## Save, publish and reset

- **Save draft** keeps your changes. Customers still see the published look.
- **Publish** puts the saved look on your chat. Customers see it the next time the chat loads.
- **Reset** puts the fields back to what is saved.
- If you leave the page or switch tabs with changes that are not saved, Studio asks first:
  **Keep editing** or **Discard changes**.

The settings on the **Behaviour** tab are saved with **Save settings** and reach customers at once.

## Check it for real

The picture is a drawing. To see your real chat with the new look, save, then press **Test chat**
on the brand. [How the test chat works](test-chat.md).

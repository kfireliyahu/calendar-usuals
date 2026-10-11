# Usuals Privacy Policy

*Effective [launch date]*

Usuals is a Chrome extension that keeps the things you usually do in a sidebar beside Google Calendar, and turns one into a calendar event when you drag it onto a time. It is made by one person, Kfir Raphael Eliyahu ("I" below).

## The short version

- Usuals has no server. Nothing it handles is ever sent to me or to anyone other than Google.
- It reads your list of calendars, and creates events only when you place an item. It deletes an event only when you press Undo on one it just created.
- It never reads your existing events through Google's API, and never sells, shares or analyses anything.
- Your items are stored in Chrome, on your computer and, if you use Chrome sync, in your Google account's Chrome sync.

## What Usuals accesses, and why

When you first use Usuals, Google asks whether to give it access to your calendars. It asks for two permissions, and uses each for one thing only.

**See the list of your calendars** (`calendar.calendarlist.readonly`). Usuals reads the list's names, colours, time zones and your access to each calendar. It uses these to show your items grouped under the calendars you own, in their colours. The list is kept in memory while Google Calendar is open, and is not stored.

**Create and delete events on calendars you own** (`calendar.events.owned`). When you drop an item onto a time, click a time with an item picked, or use an item's schedule form, Usuals creates one event, or a weekly series if you chose that. The event gets the item's name, and its description, location, colour and reminder if you set them. If you press Undo within a few seconds, Usuals deletes that event or series again. It does nothing else with this permission. In particular, it never reads, changes or deletes any other event.

**Your items.** The items you add to Usuals are its own data: each one's name and calendar, and optionally a duration, description, location, event colour and reminder. Usuals also remembers which calendar sections you have folded away.

**The Google Calendar page.** Usuals runs on calendar.google.com, where it reads parts of the page in your browser. That includes:

- which view and dates are showing, and the time zone the grid uses
- the page's colours and its light or dark theme, so the sidebar matches
- your account's display name from the page, shown in place of your email address as the name of your main calendar
- the event chips on the grid, to know when a new event has appeared and stop its loading animation; this can mean comparing the titles of events on screen with the name of the item just placed

All of this happens in your browser. Of it, only your account's display name is kept (see below), and nothing is sent anywhere.

## What is stored, and where

| What | Where | How long |
| --- | --- | --- |
| Your items and folded sections | Chrome's extension sync storage (`chrome.storage.sync`), and a copy on your computer (`chrome.storage.local`) | Until you delete them or uninstall Usuals |
| Whether the sidebar is collapsed | Your computer (`chrome.storage.local`) | Until you uninstall Usuals |
| Your account's display name and your main calendar's ID (your email address) | Your computer (`chrome.storage.local`) | Until you uninstall Usuals |
| The events Usuals creates | Your Google Calendar | Until you delete them; they are your events |

When Chrome sync is on, Chrome copies the sync storage to the other computers signed in to the same Chrome profile, through **Chrome Sync, which is operated by Google** under [Google's Privacy Policy](https://policies.google.com/privacy). With Chrome sync off, it stays on your computer.

Usuals does not store your Google sign-in. Access to your calendars goes through Chrome's own sign-in for extensions (`chrome.identity`), which keeps the access token.

## What is sent, and to whom

Usuals talks to exactly one service: Google's Calendar API, at `www.googleapis.com`, over an encrypted connection. It sends three kinds of request: one to fetch your calendar list, one to create an event, and one to delete an event when you press Undo. Apart from these, the only data that leaves your computer is the sync storage, sent by Chrome itself.

Usuals has no analytics, no crash reporting, no advertising and no tracking. It shares nothing with third parties, and I never receive any of your data.

## Google API Services

Usuals' use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

Information received from Google APIs is used only to provide the features described above, inside the extension, for you. It is not transferred to anyone, used for advertising, sold, or used to train AI models, and no person reads it.

## Your choices

- **Delete an item** in the sidebar, and it is removed from storage, including Chrome sync.
- **Remove Usuals' access to your calendars** at any time in your Google Account, under [Third-party apps and services](https://myaccount.google.com/connections). Usuals then stops working until you allow it again.
- **Export your items** to a file with Export in the sidebar's footer, and add them back with Import. The file is saved where you choose on your computer and goes nowhere else.
- **Uninstall Usuals** from `chrome://extensions`. Chrome then removes the data the extension keeps on that computer. To be sure the synced copy of your items is gone too, delete them in the sidebar first, or clear your Chrome sync data in your Google Account.
- **Events Usuals created** are ordinary events in your Google Calendar. They stay until you delete them, and uninstalling Usuals does not delete them.

## Children

Usuals is not directed at children under 13, and I do not knowingly handle data from them. In any case, it handles no data off your computer.

## Changes to this policy

If Usuals ever handles data differently, this policy will be updated before that version is released, with a new effective date at the top. The policy's history is public in the source repository, at [github.com/kfireliyahu/calendar-usuals](https://github.com/kfireliyahu/calendar-usuals).

## Contact

Questions about this policy or your data: [me@kfireliyahu.com](mailto:me@kfireliyahu.com).

*Google Calendar is a trademark of Google LLC. Usuals is not made, endorsed or sponsored by Google.*

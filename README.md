# Email Toolkit

A personal Microsoft Edge extension for organising email senders and, eventually, monitoring matching emails. Job alerts and application updates are the first intended use case; the design leaves room for other email workflows.

The project is also a learning exercise in plain JavaScript, accessible interfaces, validation, local storage, and incremental development. It aims to use free tools and run locally.

## Current status

Version: **0.1.0**. Sender management and local persistence work. Gmail integration is not implemented yet.

Implemented:

- Manifest V3 extension with a black-and-white HTML/CSS popup.
- Add and remove sender email addresses.
- Add and edit an optional subject-contains rule (up to 200 characters); blank means any subject.
- Test saved rules against a sample sender and subject, with a match/no-match explanation. Samples are never saved or sent.
- Required email input, length checks, and case-insensitive duplicate detection.
- Save sender changes in extension local storage and load them on popup startup.
- Loading and saving messages, with controls disabled during storage operations.
- Preserve the current list when saving fails; keep editing disabled if loading fails.
- Keyboard form submission, Escape/Cancel, and focus restoration after actions.
- Render sender addresses as text rather than HTML.
- Reorder senders with Move up/Move down or by dragging the dotted handle.
- Show an insertion line above or below a target card and save the resulting order.

The **Scan page** button currently only updates a status message. The recent matches area is a placeholder. Saving a sender does not yet start monitoring Gmail.

## Run locally

Requirements: Microsoft Edge and a local copy of this repository. Node.js is optional for syntax checks; it is not needed to run the extension.

1. Open `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select this repository's `Extension` folder, which contains `manifest.json`.
5. Open **Email Toolkit** from the extensions menu.

After changing files, reload the extension from the extensions page and reopen its popup. Test storage through the installed extension popup; opening `index.html` directly as a normal file does not provide extension storage APIs.

No package installation, build step, account login, or backend is currently required.

## Project structure

```text
Extension/
  manifest.json       Extension configuration and permissions
  index.html          Popup markup and script loading order
  CSS/
    styles.css        Shared interface styles
  JS/
    storage.js        Validate, load, and save sender data
    sender-model.js   Convert legacy addresses and validate sender records
    matching.js       Pure sender/subject matching logic
    popup.js          Interface events, state, and rendering
README.md
```

Scripts load in this order: `storage.js`, `sender-model.js`, `matching.js`, then `popup.js`, using deferred scripts. Functions are currently shared through ordinary scripts rather than JavaScript modules.

## How sender storage works

The popup loads the sender list before enabling editing. Adding or removing a sender creates a proposed new list. The extension saves it first, then updates the in-memory list and screen only after the save succeeds.

```text
User action -> validate -> prepare new list -> save -> render
```

Data is stored in `chrome.storage.local` under the key `monitoredSenders`:

```json
{
  "monitoredSenders": [
    { "email": "alerts@example.com", "subjectContains": "application" },
    { "email": "careers@example.org", "subjectContains": "" }
  ]
}
```

Addresses retain their entered capitalisation; duplicate comparison ignores case. Stored data is validated on both loading and saving. Invalid stored data causes a loading error instead of silently being overwritten.

Legacy lists of address strings load as records with blank rules, preserving order. Loading does not write to storage; the next successful change saves the new record format. Reordering moves the address and its rule together. Edit rule changes the subject filter while keeping the address fixed.

After this change, manually verify adding and editing a rule, cancelling an edit, clearing a rule, reopening the popup, and reordering with rules attached. Mocked checks passed for legacy conversion without writes, record persistence, invalid/duplicate rejection, rule-preserving reorder, and save-failure preservation; native Edge interaction still needs checking.

The busy flag prevents overlapping saves within a single popup. Coordination between multiple simultaneously open extension views is not implemented.

## Permissions and basic security

The manifest currently requests only `storage`, for remembering the sender list. It does not request Gmail access or read email content. There are no implemented network calls or backend connections.

- Sender values are rendered with `textContent`, not inserted as HTML.
- Browser form validation is supplemented by validation in the storage layer.
- Address validation checks input format; it does not establish sender identity or verify that an address exists.
- Local extension storage is not an application-encrypted secrets vault. Do not use it for passwords or access tokens.
- Keep extension signing keys (`*.pem`) out of source control. Packaged extension files (`*.crx`) are not needed for unpacked development.

## Manual testing

Use sample addresses rather than personal data when testing.

| Check | Expected result |
| --- | --- |
| Open the popup | Saved senders load, then controls become available. |
| Add `alerts@example.com` | A sender entry appears after a successful save. |
| Close and reopen the popup | The saved sender remains. |
| Add `ALERTS@example.com` again | A duplicate validation message appears. |
| Submit an empty or malformed address | Submission is rejected. |
| Cancel or press Escape in the form | Form closes and focus returns to Add sender, except while saving. |
| Navigate using Tab and activate buttons with Enter | Controls are usable with a visible button focus outline. |
| Remove a sender, then reopen | The removed entry stays removed. |
| Remove the final sender | The empty-state message returns. |
| Move senders with Move up/Move down | Order changes and focus remains on an enabled action for the moved sender. |
| Drag a dotted handle above or below another card | An insertion line previews the drop; releasing saves the new order. |
| Reopen after reordering | The saved order remains. |
| Cancel a drag or drop onto the same card | Order stays unchanged. |
| Click Scan page | A message explains that Gmail reading is not connected. |

Failure-path checks use simulated storage failures in the automated suite. Native Edge interaction still needs manual verification.

### Rule preview

Save a sender with `application` as its subject filter. In **Test a rule**, use the same address with `Your APPLICATION was received`: expect a match. Change the subject to `New vacancy`: expect no match. Changing the sample or saving a rule clears the previous result. Unsaved edits are not used in matching.

### Automated checks

From the repository root, with Node.js installed (no packages required):

```sh
node --test tests/toolkit.test.cjs
```

The suite covers matching, legacy data conversion, invalid data, add/edit/remove/reload, preview invalidation, all 18 three-card drop positions, failed storage operations, duplicate addresses, boundary moves, and cancelling an edit. Six test groups pass. The DOM and storage are mocked: browser validation, native focus, visual layout, and actual dragging still need Edge testing.

### Edge cases and current decisions

| Case | Behaviour or limitation |
| --- | --- |
| Blank or whitespace-only rule | Matches any subject, including an empty subject, for the saved sender. |
| Blank sample subject with a nonblank rule | No match. |
| Different address casing | Matches; sender comparison ignores case by design. |
| Similar domains or plus-address aliases | No match unless the exact address is saved; aliases are not merged. |
| `job` versus `jobs` | Matches because the rule is a substring, not a whole word. |
| Punctuation such as `.*` | Literal text, not a regular expression. |
| Accents and Unicode | NFC normalisation handles equivalent composed/decomposed accents. Accents remain significant; full locale-specific case folding is not implemented. |
| HTML-looking input | Treated as plain text, never executed as markup. |
| Missing or corrupt stored rules | Loading fails without overwriting stored data. |
| Save fails | Current list/order remains unchanged and retry is available. |
| Popup closes during save | Reopen to check stored state; a closed popup cannot report completion. |
| Several extension views edit at once | Not coordinated; a later save may overwrite an earlier change. |
| Very long input | Rules limited to 200 characters and preview subjects to 1,000; larger real subjects will need an explicit policy during Gmail integration. |
| Sender spoofing or display names | Exact-address matching is not authentication. The future Gmail reader must extract the actual address, not just a display name. |
| New Gmail page layouts, unloaded messages, repeated scans | Not handled yet; page extraction and email deduplication belong to the Gmail integration milestone. |

### Optional syntax checks

With Node.js installed, run these from the repository root:

```sh
node --check Extension/JS/storage.js
node --check Extension/JS/sender-model.js
node --check Extension/JS/matching.js
node --check Extension/JS/popup.js
```

These check JavaScript syntax only. They do not test browser APIs, rendering, or persistence.

### Verification so far

- JavaScript syntax checks passed after the storage wiring was completed.
- Manual persistence testing in Edge was reported working by the project owner.
- The full checklist and storage failure scenarios have not been independently verified.
- A mocked DOM/storage check passed for keyboard moves, failed-save order preservation, busy-state reset, and all 18 combinations of source card, target card, and drop half in a three-sender list. Native Edge drag behaviour still requires manual verification.

## Troubleshooting

- **Changes are not visible:** reload the extension and reopen the popup.
- **Storage does not load:** check that the manifest includes the `storage` permission, reload the extension, and test from its popup rather than a normal file tab.
- **A load error remains:** inspect the popup console for the error. Check script order and stored data before deleting anything; resetting storage loses saved senders.
- **An action reports a save failure:** the displayed list remains unchanged. Retry after checking the popup console.

## Next milestones

1. Verify native drag-and-drop and keyboard reordering in Edge using the checklist above.
2. Verify sample matching and saved-rule editing in Edge using the checks above.
3. Gmail page reading to extract a sender and subject from an opened email.
4. Recent matches and notifications.
5. A small local backend and SQL database for matching records and tracking history.
6. Connect the automated test suite to a GitHub Actions pipeline.

Future Gmail page reading will depend on Gmail being open and loading the relevant content. Gmail interface changes may require changes to the reader. Background monitoring with Gmail closed is outside the current design.

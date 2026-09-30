const scanButton = document.querySelector("#scan-button");
const statusMessage = document.querySelector("#status-message");

scanButton.addEventListener("click", () =>{
    statusMessage.textContent=
    "Scan requested. Gmail reading is not connected yet";
})



// Interface elements
const addSenderButton = document.querySelector("#add-sender-button");
const senderForm = document.querySelector("#sender-form");
const senderEmailInput = document.querySelector("#sender-email");
const senderSubjectInput = document.querySelector("#sender-subject");
let editingEmail = null;
const cancelSenderButton = document.querySelector("#cancel-sender-button");
const senderList = document.querySelector("#sender-list");
const sendersEmptyState = document.querySelector("#senders-empty-state");
const previewForm = document.querySelector("#preview-form");
const previewFrom = document.querySelector("#preview-from");
const previewSubject = document.querySelector("#preview-subject");
const previewResult = document.querySelector("#preview-result");

function resetPreview() {
  previewResult.textContent = "Enter a sample to test your saved rules.";
}

previewForm.addEventListener("input", () => {
  previewFrom.setCustomValidity("");
  previewSubject.setCustomValidity("");
  resetPreview();
});

previewForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!storageReady || storageBusy) return;
  previewFrom.value = previewFrom.value.trim();
  previewFrom.setCustomValidity(previewFrom.value.length > 254 ? "Use 254 characters or fewer." : "");
  previewSubject.setCustomValidity(previewSubject.value.length > 1000 ? "Use 1,000 characters or fewer." : "");
  if (!previewForm.reportValidity()) return;
  try {
    const result = matchEmail(senders, { from: previewFrom.value, subject: previewSubject.value });
    previewResult.textContent = result.matched
      ? result.reason === "any-subject"
        ? "Match — this saved sender accepts any subject."
        : "Match — the sender and subject match the saved rule."
      : result.reason === "sender"
        ? "No match — this exact sender address is not in your saved list."
        : "No match — the subject does not contain the saved text.";
  } catch (error) {
    console.error("Could not preview rule:", error);
    previewResult.textContent = "Could not check this sample. Check the inputs and try again.";
  }
});

// In-memory state is updated only after storage succeeds.
let senders = [];
let storageReady = false;
let storageBusy = false;
let draggedSender = null;

function clearDragFeedback() {
  for (const card of senderList.children) {
    card.classList.remove("drop-before", "drop-after", "dragging");
  }
}

function finishDrag() {
  draggedSender = null;
  clearDragFeedback();
}

function updateControls(){
  const disabled = !storageReady || storageBusy;

  addSenderButton.disabled = disabled;
  scanButton.disabled = disabled;

  for (const control of senderForm.querySelectorAll("input, button")){
    control.disabled = disabled;
  }
  for (const control of previewForm.querySelectorAll("input, button")) {
    control.disabled = disabled;
  }

  for (const button of senderList.querySelectorAll("button")){
    button.disabled = disabled|| button.dataset.atBoundary ==="true";
  }
  for (const handle of senderList.querySelectorAll(".drag-handle")) {
    handle.draggable = !disabled;
  }
}

async function initialisePopup(){
  updateControls();
  sendersEmptyState.hidden=true;
  statusMessage.textContent="Loading senders...";

  try{
    senders = await loadSenders();
    storageReady = true;
    renderSenders();
    statusMessage.textContent=
    "Senders loaded. Gmail monitoring is not connected yet";
  }catch(error){
    console.error("Could not load senders", error);
    statusMessage.textContent=
    "Could not load senders. Reopen the popup to retry";
  }finally{
    updateControls();
  }
}

async function commitSenders(nextSenders){
  if (!storageReady || storageBusy){
    return false;
  }

  storageBusy = true;
  updateControls();
  statusMessage.textContent = "Saving senders...";

  try {
    await saveSenders(nextSenders);

    senders = nextSenders;
    renderSenders();
    resetPreview();
    return true;
  }catch (error){
    console.error("Could not save senders:", error);
    statusMessage.textContent="Could not save senders. Your sender list is unchanged. Try Again";
    return false;
  }finally{
    storageBusy=false;
    updateControls();
  }
}

function closeSenderForm() {
  const previousEmail = editingEmail;
  editingEmail = null;
  senderForm.reset();
  senderEmailInput.readOnly = false;
  senderEmailInput.setCustomValidity("");
  senderSubjectInput.setCustomValidity("");
  senderForm.hidden = true;
  const index = senders.findIndex((sender) => sender.email === previousEmail);
  const editButton = senderList.children[index]?.querySelector(".edit-rule-button");
  (editButton ?? addSenderButton).focus();
}

addSenderButton.addEventListener("click", () => {
  closeSenderForm();
  senderForm.hidden = false;
  senderEmailInput.focus();
});

cancelSenderButton.addEventListener("click", closeSenderForm);

senderForm.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !storageBusy) {
    event.preventDefault();
    closeSenderForm();
  }
});

// Clear previous validation errors when the user edits the address.
senderEmailInput.addEventListener("input", () => {
  senderEmailInput.setCustomValidity("");
});
senderSubjectInput.addEventListener("input", () => {
  senderSubjectInput.setCustomValidity("");
});

async function moveSender(email, targetIndex, direction){
  if (!storageReady || storageBusy){
    return;
  }

  const currentIndex = senders.findIndex((sender) => sender.email === email);

  if ( 
    currentIndex === -1 ||
    !Number.isInteger(targetIndex) ||
    targetIndex<0 ||
    targetIndex >= senders.length ||
    currentIndex === targetIndex
  ){
    return;
  }

  const nextSenders = [...senders];

  const [movedSender] = nextSenders.splice(currentIndex, 1);
  nextSenders.splice(targetIndex, 0, movedSender);

  const saved = await commitSenders(nextSenders);
  const focusIndex = saved ? targetIndex : currentIndex;
  const card = senderList.children[focusIndex];

  const preferredButton = card.querySelector(
    `[data-direction="${direction}"]`
  );

  const focusTarget =
  preferredButton && !preferredButton.disabled
  ? preferredButton
  :card.querySelector("button:not(:disabled)");

  focusTarget?.focus();

  if (saved){
    statusMessage.textContent=
    `Moved ${email} to position ${targetIndex+1} of ${senders.length}.`;
  }
}

function renderSenders() {
  senderList.replaceChildren();
  sendersEmptyState.hidden = senders.length > 0;

  for (const sender of senders) {
    const email = sender.email;
    const item = document.createElement("li");
    item.className = "sender-card";

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder, or use Move up and Move down";
    handle.setAttribute("aria-hidden", "true");
    handle.draggable = storageReady && !storageBusy;

    handle.addEventListener("dragstart", (event) => {
      if (!storageReady || storageBusy || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      draggedSender = email;
      event.dataTransfer.effectAllowed = "move";
      // Only an internal marker goes into the drag payload, not an address.
      event.dataTransfer.setData("text/plain", "email-toolkit-sender");
      item.classList.add("dragging");
    });
    handle.addEventListener("dragend", finishDrag);

    item.addEventListener("dragover", (event) => {
      if (draggedSender === null || !storageReady || storageBusy) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      for (const card of senderList.children) {
        card.classList.remove("drop-before", "drop-after");
      }
      if (draggedSender === email) return;
      const bounds = item.getBoundingClientRect();
      const before = event.clientY < bounds.top + bounds.height / 2;
      item.classList.add(before ? "drop-before" : "drop-after");
    });

    item.addEventListener("dragleave", (event) => {
      if (!item.contains(event.relatedTarget)) {
        item.classList.remove("drop-before", "drop-after");
      }
    });

    item.addEventListener("drop", (event) => {
      if (draggedSender === null || !storageReady || storageBusy) return;
      event.preventDefault();
      const source = draggedSender;
      const fromIndex = senders.findIndex((sender) => sender.email === source);
      const hoveredIndex = senders.findIndex((sender) => sender.email === email);
      const bounds = item.getBoundingClientRect();
      const before = event.clientY < bounds.top + bounds.height / 2;
      // Convert a gap in the original list to an index after removal.
      let targetIndex = hoveredIndex + (before ? 0 : 1);
      if (fromIndex < targetIndex) targetIndex -= 1;
      finishDrag();
      if (source !== email) moveSender(source, targetIndex, "drag");
    });

    const address = document.createElement("span");
    address.textContent = email;
    const details = document.createElement("div");
    const rule = document.createElement("p");
    rule.className = "sender-rule";
    rule.textContent = sender.subjectContains
      ? `Subject contains: ${sender.subjectContains}` : "Any subject";
    details.append(address, rule);

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "edit-rule-button";
    editButton.textContent = "Edit rule";
    editButton.setAttribute("aria-label", `Edit rule for ${email}`);
    editButton.addEventListener("click", () => {
      if (!storageReady || storageBusy) return;
      closeSenderForm();
      editingEmail = email;
      senderEmailInput.value = email;
      senderEmailInput.readOnly = true;
      senderSubjectInput.value = sender.subjectContains;
      senderForm.hidden = false;
      senderSubjectInput.focus();
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${email}`);

    removeButton.addEventListener("click", async () => {
      if (!storageReady || storageBusy) {
        return;
      }

      const index = senders.findIndex((sender) => sender.email === email);
      const nextSenders = senders.filter((sender) => sender.email !== email);
      const saved = await commitSenders(nextSenders);

      if (!saved) {
        removeButton.focus();
        return;
      }

      statusMessage.textContent = `Removed ${email}.`;
      if (editingEmail === email) closeSenderForm();

      // The clicked button no longer exists, so restore useful focus.
      const nextButton =
        senderList.children[index]?.querySelector("button:not(:disabled)");
      const previousButton =
        senderList.children[index - 1]?.querySelector("button:not(:disabled)");

      (nextButton ?? previousButton ?? addSenderButton).focus();
    });

    const index = senders.findIndex((sender) => sender.email === email);

const upButton = document.createElement("button");
upButton.type = "button";
upButton.textContent = "Move up";
upButton.dataset.direction = "up";
upButton.dataset.atBoundary = String(index === 0);
upButton.disabled = index === 0;
upButton.setAttribute("aria-label", `Move ${email} up`);

upButton.addEventListener("click", () => {
  moveSender(email, senders.findIndex((sender) => sender.email === email) - 1, "up");
});

const downButton = document.createElement("button");
downButton.type = "button";
downButton.textContent = "Move down";
downButton.dataset.direction = "down";
downButton.dataset.atBoundary = String(index === senders.length - 1);
downButton.disabled = index === senders.length - 1;
downButton.setAttribute("aria-label", `Move ${email} down`);

downButton.addEventListener("click", () => {
  moveSender(email, senders.findIndex((sender) => sender.email === email) + 1, "down");
});

const actions = document.createElement("div");
actions.className = "sender-actions";
actions.append(upButton, downButton, editButton, removeButton);
item.append(handle, details, actions);
    senderList.append(item);
  }
}

senderForm.addEventListener("submit",async (event) => {
  // Prevent the form from navigating away and reloading the popup.
  event.preventDefault();

  if (!storageReady || storageBusy){
    return;
  }

  const email = senderEmailInput.value.trim();
  senderEmailInput.value = email;
  senderEmailInput.setCustomValidity("");

  senderSubjectInput.setCustomValidity("");
  if (senderSubjectInput.value.length > 200) {
    senderSubjectInput.setCustomValidity("Use 200 characters or fewer.");
  }

  if (email.length > 254) {
    senderEmailInput.setCustomValidity(
      "Use an email address of 254 characters or fewer."
    );
  }

  if (!senderForm.reportValidity()) {
    return;
  }

  // For this tool, treat differently capitalised addresses as duplicates.
  const alreadyExists = senders.some(
    (sender) => sender.email !== editingEmail && sender.email.toLowerCase() === email.toLowerCase()
  );

  if (alreadyExists) {
    senderEmailInput.setCustomValidity(
      "You are already monitoring this sender."
    );
    senderEmailInput.reportValidity();
    return;
  }

  const record = { email, subjectContains: senderSubjectInput.value.trim() };
  const nextSenders = editingEmail === null
    ? [...senders, record]
    : senders.map((sender) => sender.email === editingEmail ? record : sender);
  const saved = await commitSenders(nextSenders);

  if (!saved) {
    senderEmailInput.focus();
    return;
  }

  closeSenderForm();

  statusMessage.textContent =
    `Saved ${email}. Gmail monitoring is not connected yet.`;
});

initialisePopup();


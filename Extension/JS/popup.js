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
const cancelSenderButton = document.querySelector("#cancel-sender-button");
const senderList = document.querySelector("#sender-list");
const sendersEmptyState = document.querySelector("#senders-empty-state");

// In-memory state is updated only after storage succeeds.
let senders = [];
let storageReady = false;
let storageBusy = false;

function updateControls(){
  const disabled = !storageReady || storageBusy;

  addSenderButton.disabled = disabled;
  scanButton.disabled = disabled;

  for (const control of senderForm.querySelectorAll("input, button")){
    control.disabled = disabled;
  }

  for (const button of senderList.querySelectorAll("button")){
    button.disabled = disabled;
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
  senderForm.reset();
  senderEmailInput.setCustomValidity("");
  senderForm.hidden = true;
  addSenderButton.focus();
}

addSenderButton.addEventListener("click", () => {
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

function renderSenders() {
  senderList.replaceChildren();
  sendersEmptyState.hidden = senders.length > 0;

  for (const email of senders) {
    const item = document.createElement("li");
    item.className = "sender-card";

    const address = document.createElement("span");
    address.textContent = email;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${email}`);

    removeButton.addEventListener("click", async () => {
      if (!storageReady || storageBusy) {
        return;
      }

      const index = senders.indexOf(email);
      const nextSenders = senders.filter((sender) => sender !== email);
      const saved = await commitSenders(nextSenders);

      if (!saved) {
        removeButton.focus();
        return;
      }

      statusMessage.textContent = `Removed ${email}.`;

      // The clicked button no longer exists, so restore useful focus.
      const nextButton =
        senderList.children[index]?.querySelector("button");
      const previousButton =
        senderList.children[index - 1]?.querySelector("button");

      (nextButton ?? previousButton ?? addSenderButton).focus();
    });

    item.append(address, removeButton);
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
    (sender) => sender.toLowerCase() === email.toLowerCase()
  );

  if (alreadyExists) {
    senderEmailInput.setCustomValidity(
      "You are already monitoring this sender."
    );
    senderEmailInput.reportValidity();
    return;
  }

  const saved = await commitSenders([...senders, email]);

  if (!saved) {
    senderEmailInput.focus();
    return;
  }

  closeSenderForm();

  statusMessage.textContent =
    `Saved ${email}. Gmail monitoring is not connected yet.`;
});

initialisePopup();

const scanButton = document.querySelector("#scan-button");
const statusMessage = document.querySelector("#status-message");

scanButton.addEventListener("click", () =>{
    statusMessage.textContent=
    "Scan requested. Gmail reading is not connected yet";
})
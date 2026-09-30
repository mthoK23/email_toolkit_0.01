// Pure matching logic: no DOM, storage writes, or network requests.
function matchEmail(senders, email) {
  if (!email || typeof email.from !== "string" || typeof email.subject !== "string") {
    throw new Error("A sample needs a sender address and a subject string.");
  }
  const from = email.from.trim().toLowerCase();
  if (!from || from.length > 254 || email.subject.length > 1000) {
    throw new Error("Sample email is missing an address or exceeds the length limit.");
  }
  const sender = senders.find((record) => record.email.toLowerCase() === from);
  if (!sender) return { matched: false, reason: "sender" };

  // Literal substring matching, not regular expressions or whole-word matching.
  const subject = email.subject.normalize("NFC").toLowerCase();
  const keyword = sender.subjectContains.trim().normalize("NFC").toLowerCase();
  if (keyword && !subject.includes(keyword)) {
    return { matched: false, reason: "subject" };
  }
  return { matched: true, reason: keyword ? "subject" : "any-subject" };
}

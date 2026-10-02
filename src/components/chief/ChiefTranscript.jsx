export function ChiefTranscript({
  userLine = "",
  answer = "",
  answerRef = null,
  isLoading = false,
  notFound = false,
  showEmpty = false,
  onBackToList,
}) {
  if (notFound) {
    return (
      <div className="chief-turn">
        <p className="chief-turn-answer">That conversation is not available.</p>
        <button type="button" className="chief-action chief-action--quiet" onClick={onBackToList}>
          Back to conversations
        </button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="chief-turn">
        <p className="chief-turn-note">Loading conversation...</p>
      </div>
    );
  }

  if (showEmpty && !userLine && !answer) return null;

  return (
    <div className="chief-turn">
      {userLine ? <p className="chief-turn-user">{userLine}</p> : null}
      {answer ? (
        <p className="chief-answer" ref={answerRef}>
          {answer}
        </p>
      ) : null}
    </div>
  );
}

export function ChiefEarlierTurns({ earlier = [] }) {
  if (!earlier.length) return null;
  return (
    <div className="chief-earlier">
      <div className="chief-sheet-title">Earlier in this conversation</div>
      {earlier.map((message) => (
        <p
          key={message.id}
          className={message.role === "user" ? "chief-earlier-user" : "chief-earlier-chief"}
        >
          {message.text}
        </p>
      ))}
    </div>
  );
}

import { useEffect, useRef } from "react";
import { ChiefApprovalCard } from "./ChiefApprovalCard.jsx";
import { ChiefComposer } from "./ChiefComposer.jsx";
import { ChiefEarlierTurns, ChiefTranscript } from "./ChiefTranscript.jsx";

export function ChiefVoiceDock({
  signedIn = false,
  userLine = "",
  answer = "",
  earlier = [],
  answerRef = null,
  historyLoading = false,
  notFound = false,
  showEmpty = false,
  onBackToList,
  draft = "",
  onDraft,
  onSubmit,
  disabled = false,
  listening = false,
  interim = "",
  onMicrophone,
  composerRef = null,
  approval = false,
  onApprove,
  onDeny,
  archived = false,
  onRestore,
  voices = [],
  voicesLoading = false,
  voicesError = "",
  voiceId = "",
  onVoiceId,
  onRetryVoices,
  speechError = "",
  showResponseText = true,
  enterToSend = true,
}) {
  const logRef = useRef(null);
  const expanded = Boolean(
    draft.trim() ||
    listening ||
    interim ||
    userLine ||
    answer ||
    historyLoading ||
    notFound ||
    voicesError ||
    speechError ||
    approval ||
    archived
  );

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [userLine, answer, interim, speechError, historyLoading, notFound]);

  return (
    <section
      className={
        expanded
          ? "chief-apex-dock chief-voice-dock is-expanded"
          : "chief-apex-dock chief-voice-dock is-idle"
      }
      aria-label="Talk with CHIEF"
    >
      <div className="chief-voice-provider">
        <span>Provider: ElevenLabs</span>
        {voicesLoading ? <span className="chief-voice-note">Loading voices…</span> : null}
        {voicesError ? (
          <span className="chief-voice-note" role="alert">
            {voicesError}
            {onRetryVoices ? (
              <button type="button" className="chief-text-button" onClick={onRetryVoices}>
                Retry
              </button>
            ) : null}
          </span>
        ) : null}
        {signedIn && !voicesError && voices.length > 0 ? (
          <label className="chief-voice-pick">
            <span className="chief-sr">ElevenLabs voice</span>
            <select
              value={voiceId}
              disabled={disabled && !listening}
              onChange={(event) => onVoiceId?.(event.target.value)}
            >
              {voices.map((voice) => (
                <option key={voice.voice_id} value={voice.voice_id}>
                  {voice.name} · {voice.voice_id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {signedIn ? (
        <div className="chief-voice-dock-log" ref={logRef}>
          <ChiefEarlierTurns earlier={earlier} showResponseText={showResponseText} />
          <ChiefTranscript
            userLine={userLine}
            answer={answer}
            answerRef={answerRef}
            isLoading={historyLoading}
            notFound={notFound}
            showEmpty={showEmpty}
            showResponseText={showResponseText}
            onBackToList={onBackToList}
          />
          {interim ? <p className="chief-voice-interim">{interim}</p> : null}
          {speechError ? (
            <p className="chief-voice-note" role="alert">
              {speechError}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="chief-voice-note">Sign in to talk with CHIEF.</p>
      )}

      {signedIn && approval ? (
        <ChiefApprovalCard disabled={disabled} onApprove={onApprove} onDeny={onDeny} />
      ) : null}
      {signedIn && !approval && archived ? (
        <div className="chief-archived-note">
          <p>This conversation is archived. Restore it to continue.</p>
          <button type="button" className="chief-action" disabled={disabled} onClick={onRestore}>
            Restore
          </button>
        </div>
      ) : null}
      {signedIn && !approval && !archived ? (
        <ChiefComposer
          value={draft}
          onChange={onDraft}
          onSubmit={onSubmit}
          disabled={disabled}
          listening={listening}
          onMicrophone={onMicrophone}
          enterToSend={enterToSend}
          inputRef={composerRef}
        />
      ) : null}
    </section>
  );
}

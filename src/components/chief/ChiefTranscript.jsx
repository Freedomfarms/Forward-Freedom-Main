import { parseChiefMarkdown } from "../../utils/chiefMarkdown.js";

function InlineRun({ nodes }) {
  return (nodes ?? []).map((node, index) => {
    if (node.type === "strong") return <strong key={index}>{node.value}</strong>;
    if (node.type === "em") return <em key={index}>{node.value}</em>;
    if (node.type === "code") return <code key={index}>{node.value}</code>;
    if (node.type === "link") {
      return (
        <a key={index} href={node.href} target="_blank" rel="noreferrer">
          {node.value}
        </a>
      );
    }
    return <span key={index}>{node.value}</span>;
  });
}

export function ChiefMarkdown({ text }) {
  const blocks = parseChiefMarkdown(text);
  if (!blocks.length) return null;
  return (
    <div className="chief-md">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Tag = `h${Math.min(block.level, 6)}`;
          return (
            <Tag key={index}>
              <InlineRun nodes={block.inlines} />
            </Tag>
          );
        }
        if (block.type === "code") {
          return (
            <pre key={index}>
              <code>{block.value}</code>
            </pre>
          );
        }
        if (block.type === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <InlineRun nodes={item} />
                </li>
              ))}
            </Tag>
          );
        }
        if (block.type === "table") {
          return (
            <table key={index}>
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th key={cellIndex}>
                      <InlineRun nodes={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>
                        <InlineRun nodes={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        return (
          <p key={index}>
            <InlineRun nodes={block.inlines} />
          </p>
        );
      })}
    </div>
  );
}

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
        <div className="chief-answer" ref={answerRef}>
          <ChiefMarkdown text={answer} />
        </div>
      ) : null}
    </div>
  );
}

export function ChiefEarlierTurns({ earlier = [] }) {
  if (!earlier.length) return null;
  return (
    <div className="chief-earlier">
      <div className="chief-sheet-title">Earlier in this conversation</div>
      {earlier.map((message) =>
        message.role === "user" ? (
          <p key={message.id} className="chief-earlier-user">
            {message.text}
          </p>
        ) : (
          <div key={message.id} className="chief-earlier-chief">
            <ChiefMarkdown text={message.text} />
          </div>
        )
      )}
    </div>
  );
}

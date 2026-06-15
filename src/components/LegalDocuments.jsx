import { LEGAL_CONTENT } from "../content/legalContent.js";

export function LegalModal({ activeDocument, closeDocument }) {
  const document = activeDocument ? LEGAL_CONTENT[activeDocument] : null;
  if (!document) return null;

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDocument();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(1,6,14,.82)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(860px, 100%)",
          maxHeight: "82vh",
          overflowY: "auto",
          borderRadius: 18,
          border: "1px solid rgba(0,174,255,.24)",
          background: "linear-gradient(180deg, rgba(5,19,37,.98), rgba(3,12,24,.98))",
          boxShadow: "0 0 50px rgba(0,136,255,.22)",
          padding: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            alignItems: "flex-start",
            marginBottom: 24,
          }}
        >
          <div>
            <div
              style={{
                color: "#8feaff",
                textTransform: "uppercase",
                letterSpacing: 1.4,
                fontSize: 12,
                fontWeight: 900,
              }}
            >
              {document.eyebrow || "Legal notice"}
            </div>
            <div style={{ color: "white", fontSize: 30, fontWeight: 900, marginTop: 10 }}>
              {document.title}
            </div>
            {document.updated ? (
              <div style={{ color: "#8fb0d0", marginTop: 8 }}>Updated {document.updated}</div>
            ) : null}
          </div>

          <button
            onClick={closeDocument}
            style={{
              background: "transparent",
              border: "1px solid rgba(0,174,255,.28)",
              color: "#dff7ff",
              borderRadius: 10,
              padding: "10px 14px",
              cursor: "pointer",
              fontWeight: 800,
            }}
          >
            Close
          </button>
        </div>

        {Array.isArray(document.intro) && document.intro.length > 0 ? (
          <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
            {document.intro.map((paragraph, index) => (
              <div key={index} style={{ color: "#c6d7ea", lineHeight: 1.7, fontSize: 15 }}>
                {paragraph}
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 16 }}>
          {document.sections.map((section) => (
            <section
              key={section.heading}
              style={{
                borderRadius: 16,
                border: "1px solid rgba(0,136,255,.18)",
                background: "rgba(3,17,32,.68)",
                padding: 18,
              }}
            >
              <div style={{ color: "white", fontSize: 18, fontWeight: 900 }}>{section.heading}</div>
              {section.body ? (
                <div
                  style={{
                    color: "#c6d7ea",
                    lineHeight: 1.7,
                    marginTop: 10,
                    whiteSpace: "pre-line",
                  }}
                >
                  {section.body}
                </div>
              ) : null}
              {Array.isArray(section.bullets) && section.bullets.length > 0 ? (
                <ul
                  style={{
                    color: "#c6d7ea",
                    lineHeight: 1.7,
                    margin: "12px 0 0",
                    paddingLeft: 22,
                  }}
                >
                  {section.bullets.map((bullet) => (
                    <li key={bullet} style={{ marginBottom: 4 }}>
                      {bullet}
                    </li>
                  ))}
                </ul>
              ) : null}
              {section.footer ? (
                <div
                  style={{
                    color: "#c6d7ea",
                    lineHeight: 1.7,
                    marginTop: 12,
                    whiteSpace: "pre-line",
                  }}
                >
                  {section.footer}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

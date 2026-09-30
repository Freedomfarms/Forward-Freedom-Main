export function ChiefModelSelect({ models = [], value = null, disabled = false, onChange }) {
  const groups = [];
  for (const model of models) {
    if (!model?.id || !model?.group) continue;
    let group = groups.find((entry) => entry.label === model.group);
    if (!group) {
      group = { label: model.group, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  if (!groups.length) return null;

  return (
    <label className="chief-model-select">
      <span className="chief-sr">Model</span>
      <select
        aria-label="Model"
        value={value || ""}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next && next !== value) onChange(next);
        }}
      >
        <option value="">{value ? "Model" : "Default"}</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

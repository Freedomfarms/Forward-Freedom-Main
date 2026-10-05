export function FreedomButton({ variant = "primary", type = "button", className = "", ...props }) {
  const classes = ["chief-action"];
  if (variant === "quiet") classes.push("chief-action--quiet");
  if (className) classes.push(className);
  return <button type={type} className={classes.join(" ")} {...props} />;
}

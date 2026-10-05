export function FreedomGlass({ className = "", children, ...props }) {
  const classes = className ? `freedom-glass ${className}` : "freedom-glass";
  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
}

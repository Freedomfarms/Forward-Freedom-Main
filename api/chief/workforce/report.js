import { handleWorkforceReport } from "../../../server/chief/workforce/reportRoute.js";

export { handleWorkforceReport };

export default function handler(request, response) {
  return handleWorkforceReport(request, response);
}

import { handleWorkforceReportKey } from "../../../server/chief/workforce/reportRoute.js";

export { handleWorkforceReportKey };

export default function handler(request, response) {
  return handleWorkforceReportKey(request, response);
}

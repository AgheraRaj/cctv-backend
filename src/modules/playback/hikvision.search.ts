import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import logger from "../../utils/logger.js";

export interface RecordingSegment {
  startTime: Date;
  endTime: Date;
  channel: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
});

// Build the ISAPI search XML body
const buildSearchXML = (
  channel: number,
  startTime: Date,
  endTime: Date
): string => {
  const trackID = channel * 100 + 1
  const start = startTime.toISOString().split('.')[0] + 'Z'
  const end = endTime.toISOString().split('.')[0] + 'Z'

  return `<?xml version="1.0" encoding="utf-8"?><CMSearchDescription><searchID>CBB5C492-9FA0-0001-90CF-6A02B5D417F9</searchID><trackList><trackID>${trackID}</trackID></trackList><timeSpanList><timeSpan><startTime>${start}</startTime><endTime>${end}</endTime></timeSpan></timeSpanList><maxResults>100</maxResults><searchResultPostion>0</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`
}

export const searchHikvisionRecordings = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  channel: number,
  startTime: Date,
  endTime: Date,
): Promise<RecordingSegment[]> => {
  const url = `http://${ip}:${httpPort}/ISAPI/ContentMgmt/search`;
  const xmlBody = buildSearchXML(channel, startTime, endTime);

  let responseData: string;

  try {
    console.log("Sending XML body:", JSON.stringify(xmlBody));

    const response = await axios.post<string>(url, xmlBody, {
      auth: { username, password },
      headers: { "Content-Type": "application/xml" },
      responseType: "text",
      timeout: 15000,
      transformRequest: [(data) => data], // prevent axios from touching the body
    });
    responseData = response.data;
  } catch (err) {
  if (axios.isAxiosError(err) && err.response) {
    logger.error(`Hikvision search raw response: ${err.response.data}`)
  }
  logger.error(`Hikvision recording search failed for ${ip} ch${channel}: ${String(err)}`)
  throw err
}

  const parsed = parser.parse(responseData);
  const matchList = parsed?.CMSearchResult?.matchList?.searchMatchItem;

  if (!matchList) return [];

  // Normalize — single result comes as object, multiple as array
  const items = Array.isArray(matchList) ? matchList : [matchList];

  return items
    .map((item: { timeSpan?: { startTime?: string; endTime?: string } }) => {
      const start = item?.timeSpan?.startTime;
      const end = item?.timeSpan?.endTime;
      if (!start || !end) return null;
      return {
        channel,
        startTime: new Date(start),
        endTime: new Date(end),
      };
    })
    .filter((s): s is RecordingSegment => s !== null);
};

// src/modules/playback/hikvision.search.ts

import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import { env } from "../../config/env.js";
import { withRetry } from "../../utils/retry.js";


export interface RecordingSegment {
  startTime: Date;
  endTime: Date;
  channel: number;
  token?: string;
  playbackURI?: string; // NEW — raw rtsp playback URI with embedded name+size,
                        // required by the ISAPI download strategy. Optional so
                        // existing callers (adapters, segment.utils) are unaffected.
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
});

const PAGE_SIZE = 100;

// Build the ISAPI search XML body
const buildSearchXML = (
  channel: number,
  startTime: Date,
  endTime: Date,
  searchResultPosition: number
): string => {
  const trackID = channel * 100 + 1
  const start = startTime.toISOString().split('.')[0] + 'Z'
  const end = endTime.toISOString().split('.')[0] + 'Z'

  return `<?xml version="1.0" encoding="utf-8"?><CMSearchDescription><searchID>CBB5C492-9FA0-0001-90CF-6A02B5D417F9</searchID><trackList><trackID>${trackID}</trackID></trackList><timeSpanList><timeSpan><startTime>${start}</startTime><endTime>${end}</endTime></timeSpan></timeSpanList><maxResults>${PAGE_SIZE}</maxResults><searchResultPostion>${searchResultPosition}</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`
}

// A single ISAPI search page. Read-only + idempotent, so bounded retry on
// network/5xx failures is safe (Phase 4) — auth/4xx failures are NOT retried,
// since retrying the same bad credentials wastes the NVR's request budget
// and will never succeed.
const searchPage = async (
  url: string,
  username: string,
  password: string,
  channel: number,
  startTime: Date,
  endTime: Date,
  searchResultPosition: number
): Promise<{ items: any[]; isEnd: boolean; numOfMatches: number }> => {
  const xmlBody = buildSearchXML(channel, startTime, endTime, searchResultPosition);
  console.debug(`Hikvision search page: pos=${searchResultPosition} ch=${channel}`);

  const responseData = await withRetry(
    async () => {
      try {
        const response = await axios.post<string>(url, xmlBody, {
          auth: { username, password },
          headers: { "Content-Type": "application/xml" },
          responseType: "text",
          timeout: 15000,
          transformRequest: [(data) => data], // prevent axios from touching the body
        });
        return response.data;
      } catch (err) {
        if (axios.isAxiosError(err) && err.response) {
          console.error(`Hikvision search raw response: ${err.response.data}`);
          // 4xx (auth/bad request) — not retry-worthy, rethrow a tagged error.
          if (err.response.status >= 400 && err.response.status < 500) {
            const nonRetryable = new Error(`Hikvision search rejected (HTTP ${err.response.status})`);
            (nonRetryable as any).nonRetryable = true;
            throw nonRetryable;
          }
        }
        throw err;
      }
    },
    {
      retries: env.PLAYBACK_SEARCH_RETRIES,
      baseDelayMs: 500,
      isRetryable: (err) => !(err as any)?.nonRetryable,
      label: `Hikvision search (${channel}, pos=${searchResultPosition})`,
    }
  );

  const parsed = parser.parse(responseData);
  const result = parsed?.CMSearchResult;
  const matchList = result?.matchList?.searchMatchItem;
  const items = matchList ? (Array.isArray(matchList) ? matchList : [matchList]) : [];
  const numOfMatches = Number(result?.numOfMatches ?? items.length);
  const responseStatus = result?.responseStatus;
  // ISAPI signals no-more-results either via responseStatusStrg or by
  // returning fewer than a full page — treat either as the end.
  const isEnd = responseStatus === false || responseStatus === 'false' || items.length < PAGE_SIZE;

  return { items, isEnd, numOfMatches };
};

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

  const allItems: any[] = [];
  let position = 0;

  // Loop until the NVR signals no more results — closes the silent-
  // truncation gap where a >100-result day would previously be cut off
  // without warning (Phase 4).
  // Bounded to a generous number of pages as a safety valve against a
  // misbehaving NVR that never reports isEnd.
  for (let page = 0; page < 50; page++) {
    const { items, isEnd } = await searchPage(url, username, password, channel, startTime, endTime, position);
    allItems.push(...items);
    if (isEnd || items.length === 0) break;
    position += PAGE_SIZE;
  }

  if (allItems.length >= PAGE_SIZE * 50) {
    console.warn(`Hikvision search for ch${channel} hit the pagination safety cap — results may be incomplete.`);
  }

  return allItems
    .map((item: {
      timeSpan?: { startTime?: string; endTime?: string };
      mediaSegmentDescriptor?: { playbackURI?: string };
    }): RecordingSegment | null => {
      const start = item?.timeSpan?.startTime;
      const end = item?.timeSpan?.endTime;
      if (!start || !end) return null;

      const playbackURI = item?.mediaSegmentDescriptor?.playbackURI;

      return {
        channel,
        startTime: new Date(start),
        endTime: new Date(end),
        ...(playbackURI ? { playbackURI: String(playbackURI) } : {}),
      };
    })
    .filter((s): s is RecordingSegment => s !== null);
};
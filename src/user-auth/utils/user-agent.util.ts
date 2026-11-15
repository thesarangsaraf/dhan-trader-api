/**
 * Utility to parse User-Agent headers into readable browser, OS, and device categories.
 */
export interface ParsedUserAgent {
  browser: string;
  os: string;
  deviceType: 'Desktop' | 'Mobile' | 'Tablet';
}

export function parseUserAgent(ua?: string): ParsedUserAgent {
  if (!ua || typeof ua !== 'string') {
    return {
      browser: 'Web Browser',
      os: 'Unknown OS',
      deviceType: 'Desktop',
    };
  }

  // OS detection (iPhone/iPad contains "like Mac OS X", so check iOS first)
  let os = 'Unknown OS';
  if (/iPhone|iPad|iPod/i.test(ua)) {
    os = 'iOS';
  } else if (/Android/i.test(ua)) {
    os = 'Android';
  } else if (/Mac OS X|Macintosh/i.test(ua)) {
    os = 'macOS';
  } else if (/Windows NT/i.test(ua)) {
    os = 'Windows';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  // Device type
  let deviceType: 'Desktop' | 'Mobile' | 'Tablet' = 'Desktop';
  if (/iPad|Tablet/i.test(ua)) {
    deviceType = 'Tablet';
  } else if (/Mobile|Android|iPhone|iPod/i.test(ua)) {
    deviceType = 'Mobile';
  }

  // Browser detection (order matters because Chrome UA includes Safari)
  let browser = 'Web Browser';
  if (/Edg\//i.test(ua)) {
    browser = 'Edge';
  } else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) {
    browser = 'Chrome';
  } else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
    browser = 'Safari';
  } else if (/Firefox\//i.test(ua)) {
    browser = 'Firefox';
  } else if (/Opera|OPR\//i.test(ua)) {
    browser = 'Opera';
  }

  return { browser, os, deviceType };
}

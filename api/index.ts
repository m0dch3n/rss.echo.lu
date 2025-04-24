import { Hono } from 'hono'
import { handle } from 'hono/vercel'

export const config = {
  runtime: 'edge'
}

const app = new Hono().basePath('/')

interface Event {
  id: string;
  title: { en?: string; fr?: string; de?: string };
  description: { en?: string; fr?: string; de?: string };
  dates: Array<{ from: string }>;
  venues: Array<{ location?: { address: { number: string; street: string; postcode: string; town: string; country: string } } }>;
  pictures: Array<{ previews?: { media?: { url: string } }; alt?: string }>;
  categories: string[];
  tags: string[];
}

// Shared function to fetch data from echo.lu API
async function fetchEchoData(queryParams: URLSearchParams) {
  let url = 'https://api.echo.lu/v1/allExperiences';

  const apiKey = queryParams.get('api-key');

  if (!apiKey) {
    throw new Error('API key is required');
  }

  // Handle timeRange parameter
  const timeRange = queryParams.get('timeRange');
  if (timeRange) {
    const now = new Date();
    let fromDate = new Date();
    let toDate = new Date();

    // Remove brackets if present
    const cleanTimeRange = timeRange.replace(/[\[\]]/g, '');

    switch (cleanTimeRange) {
      case 'today':
        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);
        break;
      case 'tomorrow':
        fromDate.setDate(now.getDate() + 1);
        fromDate.setHours(0, 0, 0, 0);
        toDate.setDate(now.getDate() + 1);
        toDate.setHours(23, 59, 59, 999);
        break;
      case 'weekend':
        // Find next Saturday
        const daysUntilWeekend = (6 - now.getDay() + 7) % 7;
        fromDate.setDate(now.getDate() + daysUntilWeekend);
        fromDate.setHours(0, 0, 0, 0);
        toDate = new Date(fromDate);
        toDate.setDate(fromDate.getDate() + 1); // Include Sunday
        toDate.setHours(23, 59, 59, 999);
        break;
      case 'week':
        fromDate.setHours(0, 0, 0, 0);
        toDate.setDate(now.getDate() + 6);
        toDate.setHours(23, 59, 59, 999);
        break;
      case 'next-week':
        fromDate.setDate(now.getDate() + 7);
        fromDate.setHours(0, 0, 0, 0);
        toDate.setDate(fromDate.getDate() + 6);
        toDate.setHours(23, 59, 59, 999);
        break;
      case 'month':
        fromDate.setHours(0, 0, 0, 0);
        toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        break;
    }

    // Remove timeRange and add from/to parameters
    queryParams.delete('timeRange');
    queryParams.set('date[from]', fromDate.toISOString().split('.')[0]+'Z');
    queryParams.set('date[to]', toDate.toISOString().split('.')[0]+'Z');
  }

  // Remove api-key from queryParams before forwarding
  queryParams.delete('api-key');

  // Transform array parameters
  const transformedParams = new URLSearchParams();
  for (const [key, value] of queryParams.entries()) {
    if (value.startsWith('[') && value.endsWith(']') && key !== 'date[from]' && key !== 'date[to]') {
      const values = value.slice(1, -1).split(',');
      values.forEach(v => transformedParams.append(key, v.trim()));
    } else {
      transformedParams.append(key, value);
    }
  }

  if (transformedParams.toString()) {
    url += '?' + transformedParams.toString();
  }

  const options = {
    method: 'GET',
    headers: { 'api-key': apiKey, Accept: 'application/json' }
  };

  const response = await fetch(url, options);
  return response.json();
}

// Helper function to convert data to RSS format
function convertToRSS(data: { records: Event[] }, requestUrl: string): string {
  const feedUrl = new URL(requestUrl);

  // Sort records in reverse chronological order
  const sortedRecords = [...data.records].sort((a, b) => {
    const dateA = a.dates[0]?.from ? new Date(a.dates[0].from) : new Date();
    const dateB = b.dates[0]?.from ? new Date(b.dates[0].from) : new Date();
    return dateB.getTime() - dateA.getTime();  // Reverse chronological order
  });

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Events and experiences</title>
    <link>https://echo.lu</link>
    <atom:link href="${feedUrl.href}" rel="self" type="application/rss+xml" />
    <description>Events and experiences</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${sortedRecords.map((event: Event) => {
    const date = event.dates[0]?.from
      ? new Date(event.dates[0].from)
      : new Date();

    // Only use future dates or fallback to current date
    const pubDate = date;

    const venue = event.venues[0];
    const address = venue?.location?.address;
    const location = address?.number + ' ' + address?.street + ', ' + address?.postcode + ' ' + address?.town;
    const imageUrl = event.pictures[0]?.previews?.media?.url || '';
    const title = event.title.en || event.title.fr || event.title.de || 'Event';
    const description = event.description.en || event.description.fr || event.description.de || '';

    // Sanitize HTML in description to only allow specific tags
    const allowedTags = ['p', 'br', 'b', 'i', 'strong', 'em', 'ul', 'ol', 'li', 'a'];

    // First remove any style tags and their content
    const withoutStyles = description.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Then sanitize remaining HTML tags
    const sanitizedDescription = withoutStyles.replace(
      /<\/?([a-zA-Z0-9]+)[^>]*>/g,
      (tag, tagName) => {
        if (allowedTags.includes(tagName.toLowerCase())) {
          return tag;
        }
        return '';
      }
    );

    // Convert relative image URLs to absolute
    const absoluteImageUrl = imageUrl
      ? (imageUrl.startsWith('http') ? imageUrl : `https://echo.lu${imageUrl}`)
      : '';

    return `
    <item>
      <title>${escapeXml(title)}</title>
      <link>https://www.echo.lu/en/experiences/${event.id}</link>
      <guid>https://www.echo.lu/en/experiences/${event.id}</guid>
      <pubDate>${pubDate.toUTCString()}</pubDate>
      <description><![CDATA[ ${sanitizedDescription} ]]></description>
      ${absoluteImageUrl ? `<enclosure type="image/jpeg" length="0" url="${absoluteImageUrl}"/>` : ''}
      ${event.tags.map(tag => `<category>${escapeXml(tag)}</category>`).join('\n      ')}
    </item>`
  }).join('\n')}
  </channel>
</rss>`;
}

// JSON endpoint
app.get('/json', async (c) => {
  try {
    const data = await fetchEchoData(new URLSearchParams(c.req.query()));
    return c.json(data);
  } catch (error) {
    if (error instanceof Error && error.message === 'API key is required') {
      return c.json({ error: error.message }, 401);
    }
    return c.json({ error: 'Failed to fetch data', message: error }, 500);
  }
});

// RSS endpoint
app.get('/rss', async (c) => {
  try {
    const data = await fetchEchoData(new URLSearchParams(c.req.query()));
    const rss = convertToRSS(data, c.req.url);

    return new Response(rss, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'max-age=300'
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'API key is required') {
      return c.json({ error: error.message }, 401);
    }
    return c.json({ error: 'Failed to fetch data', message: error }, 500);
  }
});

// Helper function to escape XML special characters
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export default handle(app)

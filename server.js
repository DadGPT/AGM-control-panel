const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const { GoogleAIFileManager, GoogleGenAI } = require('@google/genai');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = 7761;

// ElevenLabs API Key (hardcoded)
const ELEVENLABS_API_KEY = 'sk_278ffc46da34b5b5e7c46310afe0826ce5de8872de1104e1';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use(express.static('public', {
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

app.get('/api/scrape-new-arrivals', async (req, res) => {
  try {
    console.log('🔍 Starting scrape of https://agmimports.com/new_arrival/');
    const response = await axios.get('https://agmimports.com/new_arrival/');
    console.log('✅ Got response, content length:', response.data.length);

    const $ = cheerio.load(response.data);
    console.log('✅ Cheerio loaded HTML');

    const products = [];
    let totalAnchors = 0;
    let anchorsWithImages = 0;

    // Look for product containers - they appear to be anchor tags with images
    $('a').each((index, element) => {
      totalAnchors++;
      const $element = $(element);
      const $img = $element.find('img');

      if ($img.length > 0) {
        anchorsWithImages++;
        const imageUrl = $img.attr('src');
        const link = $element.attr('href');

        // Get the product details from the container
        const $details = $element.find('.product-details');
        let title = $element.find('h2, .product-title, h3').first().text().trim();

        // If no title found in element, extract from URL
        if (!title && link) {
          const urlParts = link.split('/');
          const lastPart = urlParts[urlParts.length - 2] || urlParts[urlParts.length - 1];
          title = lastPart.replace(/-/g, ' ').replace(/\d+$/, '').trim();
          title = title.split(' ').map(word =>
            word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
          ).join(' ');
        }

        // Extract metadata from text content and image filename
        const fullText = $element.text();
        let lotNumber = '';
        let material = '';
        let color = '';

        // Try to extract lot number from image filename
        if (imageUrl) {
          const imgName = imageUrl.split('/').pop();
          const lotMatch = imgName.match(/([A-Z]+\d+)/);
          if (lotMatch) lotNumber = lotMatch[1];
        }

        // Look for material patterns in text
        const materialMatch = fullText.match(/Materials?:?\s*([^\n\r]+)/i);
        if (materialMatch) material = materialMatch[1].trim();

        // Look for color patterns in text
        const colorMatch = fullText.match(/Colors?:?\s*([^\n\r]+)/i);
        if (colorMatch) color = colorMatch[1].trim();

        // Try to extract material from title or URL
        if (!material && title) {
          if (title.toLowerCase().includes('marble')) material = 'Marble';
          else if (title.toLowerCase().includes('quartzite')) material = 'Quartzite';
          else if (title.toLowerCase().includes('granite')) material = 'Granite';
          else if (title.toLowerCase().includes('dolomite')) material = 'Dolomite';
        }

        console.log(`📦 Found anchor ${index}:`, {
          title: title || 'NO TITLE',
          imageUrl: imageUrl || 'NO IMAGE',
          link: link || 'NO LINK',
          lotNumber: lotNumber || 'NO LOT',
          material: material || 'NO MATERIAL',
          color: color || 'NO COLOR',
          textLength: fullText.length
        });

        // Only add if we have meaningful data (relaxed validation)
        if (imageUrl && link && (title || lotNumber)) {
          products.push({
            id: index,
            title: title || `Stone ${lotNumber}`,
            imageUrl: imageUrl.startsWith('http') ? imageUrl : `https://agmimports.com${imageUrl}`,
            link: link ? (link.startsWith('http') ? link : `https://agmimports.com${link}`) : '',
            lotNumber,
            material,
            color
          });
          console.log(`✅ Added product: ${title}`);
        } else {
          console.log(`❌ Skipped anchor ${index} - insufficient data`);
        }
      }
    });

    console.log(`📊 Stats: ${totalAnchors} total anchors, ${anchorsWithImages} with images, ${products.length} products before dedup`);

    // Remove duplicates based on imageUrl
    const uniqueProducts = products.filter((product, index, self) =>
      index === self.findIndex(p => p.imageUrl === product.imageUrl)
    );

    console.log(`🎯 Final result: ${uniqueProducts.length} unique products`);

    res.json({ success: true, products: uniqueProducts });
  } catch (error) {
    console.error('❌ Scraping error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/generate-seo', async (req, res) => {
  try {
    const { apiKey, product } = req.body;

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'OpenAI API key is required' });
    }

    const openai = new OpenAI({ apiKey });

    const requestData = {
      model: "gpt-5-2025-08-07",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this ${product.material} stone product image and generate an SEO-optimized description following these guidelines:

STONE DETAILS:
- Name: ${product.title}
- Material Type: ${product.material}
- Color Notes: ${product.color}

LENGTH & FORMAT:
- Target 175-225 words total
- 3-5 sentences per paragraph
- Use elevated, descriptive, yet accessible language
- Blend luxury appeal with practical application

REQUIRED STRUCTURE:

1. OPENING SENTENCE (Hook):
   - Introduce the stone by name and type (${product.material})
   - Highlight key visual attributes (color palette, texture, distinct qualities)
   - Use emotional appeal (e.g., breathtaking, dramatic, radiant, stunning)

2. VISUAL DESCRIPTION:
   - Describe background color(s) and veining patterns you see in the image
   - Emphasize contrast, movement, or light effects
   - Use evocative comparisons (e.g., "reminiscent of flowing marble," "adds depth and sophistication")

3. DESIGN VERSATILITY:
   - Note compatibility with both classic and modern designs
   - Mention pairing well with different cabinetry, materials, or styles

4. APPLICATIONS (vary the order each time):
   Include specific use cases: kitchen countertops, islands, bathroom vanities, fireplace surrounds, flooring, feature walls
   Mix functional and aspirational phrasing

5. CLOSING STATEMENT:
   - Reinforce timelessness, durability, and elegance
   - Position as ideal choice for luxury, versatility, or long-lasting beauty

SEO KEYWORDS TO INCLUDE NATURALLY:
- Use stone's full name (${product.title}) multiple times naturally
- Include: natural stone, ${product.material.toLowerCase()}, elegant, luxurious, timeless, versatile, durable
- Specific applications: kitchen countertops, bathroom vanities, islands, feature walls, flooring, fireplace surrounds

IMPORTANT:
- Do NOT include lot numbers or product codes
- Do NOT overstuff keywords - keep it natural and conversational
- DO emphasize unique visual qualities from the image (color, veining, translucence, contrast)
- DO balance emotional appeal with practical use cases
- Vary application order for freshness`
            },
            {
              type: "image_url",
              image_url: {
                url: product.imageUrl
              }
            }
          ]
        }
      ],
      max_completion_tokens: 2000
    };

    const response = await openai.chat.completions.create(requestData);

    console.log('🔍 RAW GPT-5 RESPONSE:', JSON.stringify(response, null, 2));

    const seoContent = response.choices[0].message.content;

    res.json({ success: true, seoContent });
  } catch (error) {
    console.error('❌ OpenAI API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/generate-video', async (req, res) => {
  try {
    const { apiKey, product, prompt, aspectRatio, resolution } = req.body;

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Google AI API key is required' });
    }

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Video prompt is required' });
    }

    console.log('🎬 Starting video generation for:', product.title);

    const imageResponse = await axios.get(product.imageUrl, {
      responseType: 'arraybuffer'
    });
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
    const imageMimeType = imageResponse.headers['content-type'] || 'image/jpeg';

    const requestBody = {
      instances: [{
        prompt: prompt,
        image: {
          bytesBase64Encoded: imageBase64,
          mimeType: imageMimeType
        }
      }],
      parameters: {
        aspectRatio: aspectRatio || '16:9',
        resolution: resolution || '720p'
      }
    };

    console.log('📤 Sending request to Veo 3 REST API...');

    const veoResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-generate-001:predictLongRunning`,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        }
      }
    );

    console.log('📥 Operation initiated:', veoResponse.data);

    const operationName = veoResponse.data.name;

    let isDone = false;
    let attempts = 0;
    const maxAttempts = 60;

    while (!isDone && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 10000));

      const statusResponse = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/${operationName}`,
        {
          headers: {
            'x-goog-api-key': apiKey
          }
        }
      );

      console.log(`⏳ Attempt ${attempts + 1}/${maxAttempts}... Status:`, statusResponse.data.done ? 'Done' : 'Processing');

      if (statusResponse.data.done) {
        isDone = true;

        console.log('📦 Full response data:', JSON.stringify(statusResponse.data, null, 2));

        if (statusResponse.data.error) {
          throw new Error(`API Error: ${JSON.stringify(statusResponse.data.error)}`);
        }

        if (statusResponse.data.response) {
          console.log('✅ Response object found');
          console.log('Response keys:', Object.keys(statusResponse.data.response));

          if (statusResponse.data.response.generateVideoResponse &&
              statusResponse.data.response.generateVideoResponse.generatedSamples &&
              statusResponse.data.response.generateVideoResponse.generatedSamples.length > 0) {

            const sample = statusResponse.data.response.generateVideoResponse.generatedSamples[0];
            console.log('🎥 Sample object:', JSON.stringify(sample, null, 2));

            if (sample.video && sample.video.uri) {
              console.log('✅ Video URI found, downloading...');

              const videoDownloadResponse = await axios.get(sample.video.uri, {
                headers: {
                  'x-goog-api-key': apiKey
                },
                responseType: 'arraybuffer'
              });

              const videoBase64 = Buffer.from(videoDownloadResponse.data).toString('base64');
              const videoUrl = `data:video/mp4;base64,${videoBase64}`;

              console.log('✅ Video downloaded and encoded to base64');

              res.json({
                success: true,
                videoUrl: videoUrl
              });
            } else {
              console.log('❌ No video URI found in sample');
              throw new Error('No video URI in response');
            }
          } else {
            console.log('❌ No generatedSamples array or empty array');
            throw new Error('No video generated in response');
          }
        } else {
          console.log('❌ No response object in data');
          throw new Error('No response object in API result');
        }
      }

      attempts++;
    }

    if (!isDone) {
      throw new Error('Video generation timed out after 10 minutes');
    }
  } catch (error) {
    console.error('❌ Veo 3 API error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message || 'Failed to generate video'
    });
  }
});

app.post('/api/generate-script', async (req, res) => {
  try {
    const { productDescription } = req.body;

    if (!productDescription) {
      return res.status(400).json({ success: false, error: 'Product description is required' });
    }

    console.log('📝 Generating 20-second voice script for:', productDescription);

    // Use a simple script generation (you can enhance this with OpenAI if needed)
    const script = `Discover the timeless elegance of ${productDescription.title}. This stunning ${productDescription.material} showcases ${productDescription.color} tones with exquisite natural veining. Perfect for luxury countertops, islands, and feature walls. Transform your space with natural beauty that lasts a lifetime.`;

    console.log('✅ Script generated');

    res.json({ success: true, script });
  } catch (error) {
    console.error('❌ Script generation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate script'
    });
  }
});

app.post('/api/concatenate-videos', async (req, res) => {
  try {
    const { videos, productDescription } = req.body;

    if (!videos || videos.length !== 2) {
      return res.status(400).json({ success: false, error: 'Expected 2 video URLs' });
    }

    console.log('🎬 Starting enhanced video concatenation with audio...');

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const videoFiles = [];
    const timestamp = Date.now();

    // Save video files
    for (let i = 0; i < videos.length; i++) {
      const videoData = videos[i].url.split(',')[1];
      const videoBuffer = Buffer.from(videoData, 'base64');
      const videoPath = path.join(tempDir, `video_${timestamp}_${i}.mp4`);
      fs.writeFileSync(videoPath, videoBuffer);
      videoFiles.push(videoPath);
      console.log(`✅ Saved video ${i + 1} to ${videoPath}`);
    }

    // Create reversed version of first video
    const reversedPath = path.join(tempDir, `video_${timestamp}_0_reversed.mp4`);
    console.log('🔄 Creating reversed version of first video...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoFiles[0])
        .outputOptions(['-vf reverse', '-af areverse'])
        .output(reversedPath)
        .on('end', () => {
          console.log('✅ Reversed video created');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg reverse error:', err);
          reject(err);
        })
        .run();
    });

    // Concatenate videos without audio first
    const videoNoAudioPath = path.join(tempDir, `concatenated_no_audio_${timestamp}.mp4`);
    const listPath = path.join(tempDir, `concat_list_${timestamp}.txt`);

    const listContent = [
      `file '${videoFiles[0].replace(/\\/g, '/')}'`,
      `file '${videoFiles[1].replace(/\\/g, '/')}'`,
      `file '${reversedPath.replace(/\\/g, '/')}'`
    ].join('\n');
    fs.writeFileSync(listPath, listContent);

    console.log('📝 Concatenating videos (video1 → video2 → video1 reversed)');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(videoNoAudioPath)
        .on('end', () => {
          console.log('✅ Video concatenation complete');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg concatenation error:', err);
          reject(err);
        })
        .run();
    });

    // Generate 20-second script
    console.log('📝 Generating voice script...');
    const scriptResponse = await axios.post('http://localhost:7761/api/generate-script', {
      productDescription
    });
    const script = scriptResponse.data.script;
    console.log('✅ Script generated:', script);

    // Generate voice narration using ElevenLabs
    console.log('🎙️ Generating voice narration with ElevenLabs...');
    const voiceResponse = await axios.post(
      'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM',
      {
        text: script,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );
    const voicePath = path.join(tempDir, `voice_${timestamp}.mp3`);
    fs.writeFileSync(voicePath, voiceResponse.data);
    console.log('✅ Voice narration generated');

    // Generate background music using ElevenLabs
    console.log('🎵 Generating background music with ElevenLabs...');
    const musicResponse = await axios.post(
      'https://api.elevenlabs.io/v1/sound-generation',
      {
        text: 'Elegant, sophisticated luxury showroom music with subtle ambient tones, gentle piano, and refined atmosphere for high-end stone and marble presentation',
        duration_seconds: 24,
        prompt_influence: 0.3
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );
    const musicPath = path.join(tempDir, `music_${timestamp}.mp3`);
    fs.writeFileSync(musicPath, musicResponse.data);
    console.log('✅ Background music generated');

    // Mix voice and music (reduce music volume to 30%)
    const mixedAudioPath = path.join(tempDir, `mixed_audio_${timestamp}.mp3`);
    console.log('🎚️ Mixing voice and music...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(voicePath)
        .input(musicPath)
        .complexFilter([
          '[1:a]volume=0.3[music]',
          '[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]'
        ])
        .outputOptions(['-map [aout]'])
        .output(mixedAudioPath)
        .on('end', () => {
          console.log('✅ Audio mixed successfully');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg audio mixing error:', err);
          reject(err);
        })
        .run();
    });

    // Add mixed audio to concatenated video
    const finalOutputPath = path.join(tempDir, `final_${timestamp}.mp4`);
    console.log('🎬 Adding audio to final video...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoNoAudioPath)
        .input(mixedAudioPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-shortest'
        ])
        .output(finalOutputPath)
        .on('end', () => {
          console.log('✅ Final video with audio created');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg final video error:', err);
          reject(err);
        })
        .run();
    });

    // Read final video and convert to base64
    const finalVideo = fs.readFileSync(finalOutputPath);
    const finalBase64 = finalVideo.toString('base64');
    const videoUrl = `data:video/mp4;base64,${finalBase64}`;

    // Cleanup
    videoFiles.forEach(file => fs.unlinkSync(file));
    fs.unlinkSync(reversedPath);
    fs.unlinkSync(listPath);
    fs.unlinkSync(videoNoAudioPath);
    fs.unlinkSync(voicePath);
    fs.unlinkSync(musicPath);
    fs.unlinkSync(mixedAudioPath);
    fs.unlinkSync(finalOutputPath);

    console.log('🧹 Cleaned up temporary files');

    res.json({
      success: true,
      videoUrl: videoUrl,
      script: script
    });
  } catch (error) {
    console.error('❌ Enhanced video creation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create enhanced video'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
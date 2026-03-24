---
title: "My Basic PixInsight Workflow"
date: 2025-12-01
summary: "A step-by-step walkthrough of how I process deep sky images in PixInsight — from raw calibrated frames to a finished, color-balanced result."
---

This is the core workflow I use for most deep sky images. It assumes you've already captured your lights, darks, flats, and bias frames and are starting from raw .fit/.fits files.

---

## A. Culling Poor Frames

Before stacking, review your lights and remove frames with poor quality — significant trailing from a lost guide star, clouds passing through, or frames with unusually high noise. Most acquisition software (N.I.N.A., SGP) gives you quality scores; anything below roughly 50–60% of your best frame is usually worth dropping.

*What you're looking for:* star elongation, cloud gradients, severely clipped backgrounds.

---

## B. WBPP — Weighted Batch Preprocessing

**Script:** `Script > Batch Processing > WeightedBatchPreprocessing`

WBPP handles calibration (dark/flat/bias subtraction) and stacking in one pass. Key settings:

- Set calibration frame paths (darks, flats, bias)
- Enable **Normalize** and set weighting criterion (typically signal weight or FWHM)
- Output: integrated master lights per filter (e.g. `masterLight_Ha.fits`, `masterLight_L.fits`)

The result is one integrated master frame per filter, ready for post-processing.

---

## C. StarXTerminator — Remove Stars from Masters

Run **StarXTerminator** on each master light before any further processing. Removing stars first lets you stretch and process nebulosity aggressively without bloating stars.

- `Process > StarXTerminator`
- Check *Generate star image* — you'll recombine the star layer at the end if needed
- Settings: default model is fine for most cases

You'll end up with a starless nebula image and a separate star image.

---

## D. DBE — Dynamic Background Extraction

**DBE** corrects large-scale gradients (light pollution, vignetting, thermal gradients).

- `Process > BackgroundModelization > DynamicBackgroundExtraction`
- Set **Threshold** to maximum
- Set **Grid samples** to 20 pixels
- Carefully place sample points — move or delete any that land on nebulosity (you want background only)
- Use **Expand** and **Shrink** to avoid edge/stacking artifacts when placing samples near the frame boundary

Apply the correction and check that the background is flat without affecting the nebula.

---

## E. DeepSNR — Denoise in Grayscale (if possible)

If DeepSNR is available and the image SNR allows it, denoise each channel **in linear grayscale** before combining.

- `Process > Noise Reduction > DeepSNR`
- Run on individual channel masters (Ha, L, R, G, B) before color combining
- Denoising in grayscale (linear state) is more effective than after color combination or stretching

---

## F. ChannelCombination

Combine your separate channel masters into a single color image.

- `Process > ColorSpaces > ChannelCombination`
- For LRGB: set L/R/G/B channels to their respective master files
- For narrowband (SHO/HOO): map Hα → Red, OIII → Green+Blue (HOO) or per your chosen palette

---

## G. BlurXTerminator — Correct Only

Run **BlurXTerminator** in *Correct Only* mode (no sharpening).

- `Process > BlurXTerminator`
- Uncheck sharpening — we only want PSF correction to tighten and round stars
- Apply to the combined color image

---

## H. PixelMath — RGB Luminance Average

Create a grayscale luminance image from the color frame to use as a reference for LinearFit.

- `Process > PixelMath`
- Expression: `(R + G + B) / 3`
- This produces an average-luminance image in the same intensity range as the color channels

---

## I. LinearFit — Normalize Luminance to RGB Average

Match the luminance master's intensity scale to the RGB average so the LRGB combination produces balanced results.

- `Process > IntensityTransformations > LinearFit`
- Set the reference image to the RGB average from step H
- Apply to the luminance master

---

## J. Stretch — HistogramTransformation + LRGBCombination

Stretch the luminance and color images separately, then combine.

1. **HistogramTransformation** on the starless RGB: set the midtones slider to bring up the nebulosity without clipping highlights
2. **HistogramTransformation** on the luminance master: stretch to roughly match the RGB brightness
3. **LRGBCombination** (`Process > ColorSpaces > LRGBCombination`): combine the stretched luminance with the stretched RGB for maximum detail

---

## K. CurvesTransformation — Color and Contrast

Fine-tune color balance, contrast, and saturation.

- `Process > IntensityTransformations > CurvesTransformation`
- Adjust the combined LRGB curve to bring out contrast in the nebula
- Adjust individual RGB channels for color balance
- Boost saturation via the **S** (saturation) curve if needed

---

## L. DeepSNR — Final Denoise

A final pass with DeepSNR on the stretched, color-combined image to clean up any residual noise introduced during stretching or combining.

- `Process > Noise Reduction > DeepSNR`
- Apply gently — the goal is to smooth noise without softening fine structure

---

*This workflow is a starting point, not a prescription. Every target is different. Narrowband-heavy images, galaxies, and solar targets all have their own quirks — I'll document those in separate guides over time.*

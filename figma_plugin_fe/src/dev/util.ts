/**
 * Generic function to deeply log all properties of an object
 * Used for testing/debugging node selection
 * Enhanced to handle Figma nodes with non-enumerable properties
 */
export function logNodeProperties(
  obj: any,
  depth = 0,
  maxDepth = 3,
  seen = new WeakSet(),
): void {
  const indent = "  ".repeat(depth);

  // Prevent circular references
  if (obj && typeof obj === "object") {
    if (seen.has(obj)) {
      console.log(`${indent}[Circular Reference]`);
      return;
    }
    seen.add(obj);
  }

  // Stop at max depth
  if (depth > maxDepth) {
    console.log(`${indent}[Max depth reached]`);
    return;
  }

  // Handle null/undefined
  if (obj === null || obj === undefined) {
    console.log(`${indent}${obj}`);
    return;
  }

  // Handle primitives
  if (typeof obj !== "object" || obj instanceof Date || obj instanceof RegExp) {
    console.log(`${indent}${obj}`);
    return;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      console.log(`${indent}[]`);
      return;
    }
    console.log(`${indent}Array(${obj.length}):`);
    obj.forEach((item, index) => {
      console.log(`${indent}[${index}]:`);
      logNodeProperties(item, depth + 1, maxDepth, seen);
    });
    return;
  }

  // Get both enumerable and non-enumerable properties
  const allKeys = new Set<string>();

  // Add enumerable keys
  Object.keys(obj).forEach((key) => allKeys.add(key));

  // Add non-enumerable own property names
  try {
    Object.getOwnPropertyNames(obj).forEach((key) => allKeys.add(key));
  } catch (e) {
    // Ignore errors
  }

  // Add properties from prototype chain (one level up)
  try {
    const proto = Object.getPrototypeOf(obj);
    if (proto && proto !== Object.prototype) {
      Object.getOwnPropertyNames(proto).forEach((key) => {
        if (key !== "constructor") {
          allKeys.add(key);
        }
      });
    }
  } catch (e) {
    // Ignore errors
  }

  // Convert to sorted array for consistent output
  const keys = Array.from(allKeys).sort();

  if (keys.length === 0) {
    console.log(`${indent}{}`);
    return;
  }

  keys.forEach((key) => {
    try {
      const value = obj[key];
      const valueType = typeof value;

      if (value === null) {
        console.log(`${indent}${key}: null`);
      } else if (value === undefined) {
        console.log(`${indent}${key}: undefined`);
      } else if (valueType === "symbol") {
        // Handle Symbol types specially
        console.log(`${indent}${key}: [Symbol: ${value.toString()}]`);
      } else if (valueType === "function") {
        // Skip function logging unless it's important
        if (depth === 0) {
          console.log(`${indent}${key}: [Function]`);
        }
      } else if (valueType === "object") {
        if (Array.isArray(value)) {
          console.log(`${indent}${key}: Array(${value.length})`);
          if (value.length > 0 && depth < maxDepth) {
            logNodeProperties(value, depth + 1, maxDepth, seen);
          }
        } else {
          console.log(`${indent}${key}:`);
          logNodeProperties(value, depth + 1, maxDepth, seen);
        }
      } else {
        // Primitive values (string, number, boolean, bigint)
        try {
          const stringValue = String(value);
          // Truncate very long strings
          if (stringValue.length > 100) {
            console.log(
              `${indent}${key}: ${stringValue.substring(0, 100)}... (truncated)`,
            );
          } else {
            console.log(`${indent}${key}: ${stringValue}`);
          }
        } catch (conversionError) {
          // If String() conversion fails, use a fallback
          console.log(`${indent}${key}: [Cannot convert to string]`);
        }
      }
    } catch (error) {
      console.log(`${indent}${key}: [Error: ${error}]`);
    }
  });
}

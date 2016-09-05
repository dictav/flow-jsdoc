"use strict";

var falafel = require("./lib/falafel");
var doctrine = require("doctrine"); // JSDoc parsing
var fs = require("fs");
var util = require("util");

function jsdocTagToFlowTag(tag, module) {
    // console.log(util.inspect(tag));
    return {
        loc: tag.title, //param|return
        name: tag.name, // the parameter name
        type: jsdocTypeToFlowType(tag.type) // the parameter type
    };
}

/**
 * Extract formatted JSDoc from a comment.
 * @param {String} comment The comment which may have JSDoc in it.
 * @return {Object} With 'params' and 'return' arrays which have 'loc', 'name'
 * and 'type' elements.
 */
function extractJsdoc(comment) {
    var docAst = doctrine.parse(comment, { unwrap: true });
    if (!docAst.tags) {
        return null;
    }
    // only interested in @param and @return
    var paramTags = docAst.tags.filter(function(tag) {
        return tag.title === "param";
    }).map(jsdocTagToFlowTag);

    var returnTags = docAst.tags.filter(function(tag) {
        return tag.title === "return" || tag.title === "returns" || tag.title === "enum";
    }).map(jsdocTagToFlowTag);

    return {
        params: paramTags,
        returns: returnTags
    };
}

function jsdocTypeToFlowType(jsdocType) {
    if (!jsdocType || !jsdocType.type) {
        return;
    }
    switch(jsdocType.type) {
        case "NameExpression": // {string}
            return jsdocType.name;
        case "TypeApplication": // {Foo<Bar>}
            // e.g. 'Array' in Array<String>
            var baseType = jsdocTypeToFlowType(jsdocType.expression);
            // Flow only supports single types for generics
            var specificType = jsdocTypeToFlowType(jsdocType.applications[0]);
            if (baseType && specificType) {
                return baseType + "<" + specificType + ">";
            }
            break;
        case "UnionType": // {(Object|String)}
            var types = jsdocType.elements.map(function(t) {
                return jsdocTypeToFlowType(t);
            });
            return types.join(" | ");
        case "AllLiteral": // {*}
            return "any";
        case "OptionalType": // {string=}
        case "NullableType": // {?string}
            return "?" + jsdocTypeToFlowType(jsdocType.expression);
        default:
            // console.log("Unknown jsdoc type: %s", JSON.stringify(jsdocType));
            break;
    }
}

/**
 * Retrieve a function node along with parsed JSDoc comments for it.
 * @param {Node} node The node to inspect.
 * @return {?Object} An object with "jsdoc" and "node" keys, or null.
 */
function getCommentedFunctionNode(node) {
    if (!node.leadingComments) {
        // JSDoc comments are always before the function, so if there is
        // nothing here, we ain't interested.
        return null;
    }
    /*
    console.log("=================");
    console.log("type: " + node.type);
    console.log(util.inspect(node)); */
    /*
     * We handle 5 different function representations:
     *
     *     Type               Path to Function              Example
     * ==========================================================================================
     * FunctionDeclaration           -                  function foo(bar) {}
     * VariableDeclaration   .declarations[0].init      var foo = function(bar) {}
     * ExpressionStatement   .expression.right          ObjClass.prototype.foo = function(bar) {}
     * MethodDefinition      .value                     class ObjClass { foo(bar) {} }
     * Property              .value                     var obj = { key: function(bar) {} }
     * ReturnStatement       .argument                  return function(foo, bar) {}
     */
    var nodeTypes = [
        "FunctionDeclaration", "ExpressionStatement", "VariableDeclaration",
        "MethodDefinition", "Property", "ReturnStatement"
    ];
    if (nodeTypes.indexOf(node.type) === -1) {
        return null;
    }
    var funcNode = null;
    switch (node.type) {
        case "FunctionDeclaration":
            funcNode = node;
            break;
        case "VariableDeclaration":
            funcNode = node.declarations[0].init;
            break;
        case "ExpressionStatement":
            funcNode = node.expression.right;
            break;
        case "MethodDefinition":
            funcNode = node.value;
            break;
        case "Property":
            funcNode = node.value;
            break;
        case "ReturnStatement":
            funcNode = node.argument;
            break;
    }
    var funcNodeTypes = ["FunctionDeclaration", "FunctionExpression"];
    if (!funcNode || funcNodeTypes.indexOf(funcNode.type) === -1) {
        // We can't find a function here which can map to leadingComments.
        return null;
    }
    var funcDocs = null;
    for (var i=0; i<node.leadingComments.length; i++) {
        if (node.leadingComments[i].type === "Block") {
            funcDocs = extractJsdoc(node.leadingComments[i].value);
            break;
        }
    }
    if (funcDocs === null) {
        return null;
    }

    return {
        node: funcNode,
        jsdoc: funcDocs
    };
}

/**
 * Retrieve a enum node along with parsed JSDoc comments for it.
 * @param {Node} node The node to inspect.
 * @return {?Object} An object, or null.
 */
function getCommentedEnumNode(node) {
    if (!node.leadingComments) {
        // JSDoc comments are always before the function, so if there is
        // nothing here, we ain't interested.
        return null;
    }

    /*
     * We handle 2 representations:
     * TODO: Add support @typedef
     *
     *     Type               Path to Function              Example
     * ==========================================================================================
     * VariableDeclaration   .declarations[0].init      var foo = { A:1, B:3 }
     * ExpressionStatement   .declarations[0].init      obj.foo = { A:1, B:3 }
     */
    var nodeTypes = [
        "ExpressionStatement", "VariableDeclaration"
    ];
    if (nodeTypes.indexOf(node.type) === -1) {
        return null;
    }

    var funcDocs = null;
    for (var i=0; i<node.leadingComments.length; i++) {
        var c = node.leadingComments[i]
        if (c.type === "Block" && c.value.match('@enum')) {
            funcDocs = extractJsdoc(c.value);
            break;
        }
    }
    if (funcDocs === null) {
        return null;
    }

    var enumNode = null;
    var enumName = null;
    switch (node.type) {
        case "VariableDeclaration":
            enumNode = node.declarations[0].init;
            enumName = enumNode.parent.id.name;
            break;
        case "ExpressionStatement":
            enumNode = node.expression.right;
            enumName = enumNode.parent.left.object.name;
            break;
    }
    if (enumNode === null) {
        return null;
    }

    return {
        node: enumNode,
        jsdoc: funcDocs
    }
}

function extractFuncName(node) {
    if (!node) {
        return null
    }
    switch (node.type) {
        case 'Program':
        case 'ExpressionStatement':
            return null;
        case 'MemberExpression':
            return [extractFuncName(node.object), node.property.name]
                .filter(function(a){ return a != null })
                .join('.');
        case 'AssignmentExpression':
            return extractFuncName(node.left);
        case 'Identifier':
            return node.name;
        case 'FunctionDeclaration':
            return [extractFuncName(node.parent), node.id.name]
                .filter(function(a){ return a != null })
                .join('.');
        case 'ObjectExpression': // enum
            var obj = node.parent.id;
            if (obj === undefined) {
                obj = node.parent.left;
            }
            return extractFuncName(obj)
        default:
            return extractFuncName(node.parent)
    }
}

function updateSource(src) {
    // Esprima has an undocumented 'attachComment' option which binds comments
    // to the nodes in the AST
    var output = falafel(src, {attachComment: true}, function (node) {
        var i;
        var funcNode = getCommentedFunctionNode(node);
        if (!funcNode || !funcNode.jsdoc) {
            return;
        }

        // Pair up the function params with the JSDoc params (if they exist)
        funcNode.node.params.forEach(function(param) {
            for (i = 0; i < funcNode.jsdoc.params.length; i++) {
                if (funcNode.jsdoc.params[i].name === param.name &&
                    funcNode.jsdoc.params[i].type) {
                    // replace the function param name with the type annotated param
                    param.update(
                        param.source() + "/* : " + funcNode.jsdoc.params[i].type + "*/"
                    );
                }
            }
        });

        // Pair up the return value if possible
        // we only support 1 return type currently
        var returnDoc = funcNode.jsdoc.returns[0];
        if (returnDoc && returnDoc.type && funcNode.node.body) {
            funcNode.node.body.update(
                "/* : " + returnDoc.type + "*/ " + funcNode.node.body.source()
            );
        }
    });

    return output;
}

function outputDeclaration(src) {
    var declarations = {}
    var enums = []

    falafel(src, {attachComment: true}, function (node) {
        var n = getCommentedFunctionNode(node)
        if (n) {
            var node = n.node;
            var jsdoc = n.jsdoc;

            var params = node.params.map(function(param) {
                return jsdoc.params
                    .filter(function(jp) {
                        return jp.name === param.name && jp.type
                    })
                    .map(function(jp) {
                        return param.source() + ": " + jp.type
                    })
            });

            // flatten
            params = Array.prototype.concat.apply([], params);

            var retType = jsdoc.returns[0] && jsdoc.returns[0].type;

            var decName = extractFuncName(node) 
            var arr = decName.split(".") 
            var parentDec = declarations
            var isPrototype = false
            for (var i = 0; i < arr.length; i++) {
                if (arr[i] === 'meta') {
                    throw new Error("UnexpectedError")
                }
                if (arr[i] === 'prototype') {
                    isPrototype = true
                    parentDec.meta.type = 'class'
                    continue
                }

                var d = parentDec[arr[i]]
                if (!d) {
                    d = parentDec[arr[i]] = {}
                }
                if (i === arr.length -1) {
                    d.meta = {
                        type: isPrototype ? "method" : "function",
                        name: arr[i],
                        params: params,
                        retType: retType
                    }
                }
                parentDec = d
            }

            return
        }

        n = getCommentedEnumNode(node)
        if (n) {
            var node = n.node;
            var jsdoc = n.jsdoc;

            var decName = extractFuncName(node) 
            var values = node.properties.map(function(m) {
                return m.value.value
            })
            var retType = jsdoc.returns[0] && jsdoc.returns[0].type;

            var arr = decName.split(".") 
            var parentDec = declarations
            for (var i = 0; i < arr.length; i++) {
                var d = parentDec[arr[i]]
                if (!d) {
                    d = parentDec[arr[i]] = {}
                }
                if (i === arr.length - 1) {
                    d.meta = {
                        type: 'enum',
                        name: arr[i],
                        source: node.source(),
                        values: values,
                        retType: retType
                    }
                }
                parentDec = d
            }

            return
        }
    });

    function hoge(dec, key, parent, depth) {
        var output = ""
        var indent = "    "
        if (!dec) {
            return output
        }

        if (depth === undefined) {
            depth = -1
        }

        var m = dec.meta
        delete dec.meta

        if (!m && key) {
            output += indent.repeat(depth) + "declare module " + key + " {\n"
            m = {
                module: key
            }
        }

        if (m) {
            if (parent && parent.module) {
                m.module = parent.module
            }

            var params = (function(){
              if (m.params) {
                if (m.module) {
                  return m.params.map(function(a) {
                    return a.replace(m.module + '\.', '')
                  })
                } else {
                  return m.params
                }
              } else {
                return []
              }
            })()

            var retType = ":" + (function(){
              if (m.retType) {
                if (m.module) {
                  return m.retType.replace(m.module + '\.', '')
                } else {
                  return m.retType
                }
              } else {
                return "void"
              }
            })()

            switch (m.type) {

                case 'class':
                    output += indent.repeat(depth) + "declare class " + key + " {\n"
                    if (m.name) {
                        output += indent.repeat(depth + 1) + "constructor(" + params.join(", ") + ")"
                            + retType + ";\n"
                    }
                    for (var key in dec) {
                        output += hoge(dec[key], key, m, depth + 1)
                    }
                    output += indent.repeat(depth) + "}\n"
                    return output;
                case 'method':
                    output += indent.repeat(depth) 
                        + m.name + "(" + params.join(", ") + ")"
                        + retType + ";\n"
                    break;

                case 'function':
                    var decStr = "declare function "
                    if (parent && parent.type === 'class') {
                        decStr = "static "
                    }
                    output += indent.repeat(depth) + decStr
                        + m.name + "(" + params.join(", ") + ")"
                        + retType + ";\n"
                    break;
                case 'enum':
                    enums.push(m.name)
                    var idt = indent.repeat(depth)
                    output += idt
                        + "declare var " + m.name 
                        + ":" + m.source.replace(/\n/g, "\n"+idt) + "\n"
                    output += indent.repeat(depth)
                        + "declare type " + m.name + "Value"
                        + " = " + m.values.join("|")
                        + ";\n"
                default:
                    break;
            }
        }

        for (var k in dec) {
            output += hoge(dec[k], k, m, depth + 1)
        }

        if (m && m.module && depth === 0) {
            output += indent.repeat(depth) + "}\n"
        }

        return output
    }

    var output = hoge(declarations)

    // rename enum
    enums.forEach(function(a) {
        var reg = new RegExp('(:\\s*\\??\\s*)' + a, 'g')
        output = output.replace(reg, '$1' + a+'Value')
    });
    return output
}

module.exports = function(src, opts) {
    opts = opts || {declaration: true};

    if (opts.declaration) {
        return outputDeclaration(src);
    } else {
        return updateSource(src);
    }
};
